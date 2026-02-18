# API Контракты

## Обзор

Документ описывает REST API контракты между сервисами PKG.

**Base URL:** `http://pkg-core:3000/api/v1`

**Формат:** JSON

**Аутентификация:** API Key в заголовке `X-API-Key` (между сервисами)

---

## Telegram Adapter → PKG Core

### POST /messages

Создание нового сообщения из Telegram.

**Request:**
```json
{
  "source": "telegram",
  "telegram_chat_id": "channel_12345678",
  "telegram_user_id": "87654321",
  "telegram_username": "ivan_petrov",
  "telegram_display_name": "Иван Петров",
  "telegram_user_info": {
    "username": "ivan_petrov",
    "firstName": "Иван",
    "lastName": "Петров",
    "phone": "+79161234567",
    "isBot": false,
    "isVerified": false,
    "isPremium": true,
    "photoBase64": "data:image/jpeg;base64,..."
  },
  "message_id": "999",
  "text": "Привет! Давай созвонимся завтра в 15:00",
  "timestamp": "2025-01-07T15:30:00Z",
  "is_outgoing": false,
  "reply_to_message_id": null,
  "media_type": "photo",
  "media_url": null,
  "media_metadata": {
    "id": "123456789",
    "accessHash": "987654321",
    "fileReference": "base64...",
    "dcId": 2,
    "sizes": [{"type": "x", "width": 800, "height": 600, "size": 45000}]
  },
  "chat_type": "supergroup",
  "topic_id": 123,
  "topic_name": "General",
  "participants_count": 15,
  "chat_title": "Рабочая группа"
}
```

**Response 201:**
```json
{
  "id": "msg-uuid",
  "interaction_id": "interaction-uuid",
  "entity_id": "entity-uuid",
  "entity_resolution_status": "resolved",
  "auto_created_entity": true,
  "chat_category": "working",
  "is_update": false,
  "created_at": "2025-01-07T15:30:00Z"
}
```

**Response 201 (pending resolution):**
```json
{
  "id": "msg-uuid",
  "interaction_id": "interaction-uuid",
  "entity_id": null,
  "entity_resolution_status": "pending",
  "pending_resolution_id": "pending-uuid",
  "chat_category": "mass",
  "created_at": "2025-01-07T15:30:00Z"
}
```

**Логика PKG Core:**
1. Категоризация чата (personal/working/mass) на основе chat_type и participants_count
2. Найти или создать interaction для chat_id (session logic: gap > настраиваемый порог = new session)
3. Resolve entity:
   - Для known identifier → использовать существующий entity
   - Для personal/working → автосоздание Entity с данными из telegram_user_info (кроме ботов)
   - Для mass → создать PendingEntityResolution
4. Сохранить message с media_metadata
5. Поставить в очередь генерацию embedding
6. Для working/personal → поставить в очередь extraction фактов

---

### POST /voice-jobs

Постановка voice message в очередь транскрипции.

**Request:**
```json
{
  "source": "telegram",
  "telegram_chat_id": "12345678",
  "telegram_user_id": "87654321",
  "message_id": "1000",
  "file_path": "/data/files/voice/tg_1000.ogg",
  "duration_seconds": 45,
  "timestamp": "2025-01-07T15:31:00Z"
}
```

**Response 202:**
```json
{
  "job_id": "job-uuid",
  "status": "pending",
  "webhook_url": "http://n8n:5678/webhook/voice-transcription"
}
```

---

### POST /sessions/end

Явное завершение сессии.

**Request:**
```json
{
  "telegram_chat_id": "12345678",
  "last_message_timestamp": "2025-01-07T15:35:00Z"
}
```

**Response 200:**
```json
{
  "interaction_id": "interaction-uuid",
  "status": "completed",
  "message_count": 15,
  "duration_minutes": 45
}
```

---

## Worker → PKG Core

### POST /transcript-segments

Сохранение сегментов транскрипции после обработки звонка.

**Request:**
```json
{
  "interaction_id": "interaction-uuid",
  "segments": [
    {
      "speaker_label": "Speaker_0",
      "content": "Алло, здравствуйте!",
      "start_time": 0.5,
      "end_time": 2.1,
      "confidence": 0.95
    },
    {
      "speaker_label": "Speaker_1",
      "content": "Да, слушаю вас.",
      "start_time": 2.5,
      "end_time": 4.0,
      "confidence": 0.92
    }
  ],
  "speaker_mapping": {
    "Speaker_0": { "role": "self" },
    "Speaker_1": {
      "role": "other",
      "suggested_entity_id": "entity-uuid",
      "suggested_name": "Иван Петров",
      "confidence": 0.85
    }
  }
}
```

**Response 201:**
```json
{
  "segments_created": 2,
  "pending_resolution_created": false
}
```

---

### PATCH /pending-resolutions/{id}/suggestions

Обновление suggestions для pending entity resolution.

**Request:**
```json
{
  "suggestions": [
    {
      "entity_id": "entity-uuid-1",
      "name": "Иван Петров",
      "confidence": 0.87,
      "reason": "Совпадение стиля общения, упоминание компании"
    }
  ],
  "create_new_recommended": false,
  "analysis": "Высокая вероятность совпадения..."
}
```

**Response 200:**
```json
{
  "id": "pending-uuid",
  "status": "pending",
  "suggestions_count": 1,
  "auto_resolved": false
}
```

---

### POST /interactions/{id}/summary

Сохранение summary для взаимодействия.

**Request:**
```json
{
  "summary_text": "Обсуждение технических деталей интеграции с CRM системой.",
  "key_points": ["Интеграция через REST API", "Срок - февраль 2025"],
  "decisions": ["Использовать OAuth 2.0"],
  "action_items": ["Подготовить ТЗ до 15 января"],
  "facts_extracted": [{ "type": "decision", "value": "Бюджет 150к", "confidence": 0.95 }]
}
```

**Response 201:**
```json
{
  "id": "summary-uuid",
  "interaction_id": "interaction-uuid",
  "created_at": "2025-01-07T15:00:00Z"
}
```

---

### POST /extracted-facts

Сохранение извлечённых фактов.

**Request:**
```json
{
  "entity_id": "entity-uuid",
  "source_interaction_id": "interaction-uuid",
  "facts": [
    {
      "type": "birthday",
      "value_date": "1985-03-15",
      "confidence": 0.92,
      "source_quote": "У меня день рождения 15 марта",
      "source_message_id": "msg-uuid"
    }
  ]
}
```

**Response 201:**
```json
{
  "created": 1,
  "pending": 0,
  "facts": [{ "id": "fact-uuid", "status": "created", "type": "birthday" }]
}
```

---

## Client → PKG Core

### GET /entities

Получение списка entities.

**Query:** `?type=person&search=Иван&limit=50&offset=0`

**Response 200:**
```json
{
  "items": [{
    "id": "entity-uuid",
    "type": "person",
    "name": "Иван Петров",
    "isBot": false,
    "organization": { "id": "org-uuid", "name": "ООО Рога и Копыта" },
    "last_interaction_at": "2025-01-07T15:30:00Z",
    "interaction_count": 42
  }],
  "total": 150,
  "limit": 50,
  "offset": 0
}
```

---

### GET /entities/{id}

Получение детальной информации об entity.

**Response 200:**
```json
{
  "id": "entity-uuid",
  "type": "person",
  "name": "Иван Петров",
  "isBot": false,
  "organization": { "id": "org-uuid", "name": "ООО Рога и Копыта" },
  "notes": "Технический директор",
  "identifiers": [
    { "type": "telegram_user_id", "value": "87654321", "metadata": { "username": "ivan_petrov" } },
    { "type": "phone", "value": "+79161234567" }
  ],
  "facts": [
    { "type": "position", "category": "professional", "value": "CTO", "valid_from": "2023-06-01", "source": "manual" },
    { "type": "birthday", "category": "personal", "value_date": "1985-03-15", "source": "extracted", "confidence": 0.92 }
  ],
  "stats": {
    "first_interaction_at": "2024-12-01T10:00:00Z",
    "last_interaction_at": "2025-01-07T15:30:00Z",
    "interaction_count": 42,
    "message_count": 387
  },
  "created_at": "2024-12-01T10:00:00Z",
  "updated_at": "2025-01-07T15:30:00Z"
}
```

---

### POST /entities

Создание нового entity.

**Request:**
```json
{
  "type": "person",
  "name": "Мария Сидорова",
  "organization_id": "org-uuid",
  "notes": "Менеджер проекта",
  "identifiers": [{ "type": "telegram_user_id", "value": "11111111" }],
  "facts": [{ "type": "position", "value": "Project Manager" }]
}
```

---

### POST /entities/{id}/merge/{targetId}

Слияние двух entities.

**Response 200:**
```json
{
  "merged_entity_id": "target-uuid",
  "source_entity_deleted": true,
  "identifiers_moved": 2,
  "interactions_relinked": 15,
  "facts_moved": 3
}
```

---

### POST /context

Генерация контекста по entity.

**Request:**
```json
{
  "entity_id": "entity-uuid",
  "task_hint": "обсуждение сроков проекта",
  "max_tokens": 2000,
  "include_recent_days": 30
}
```

**Response 200:**
```json
{
  "entity_id": "entity-uuid",
  "entity_name": "Иван Петров",
  "context_markdown": "## Контекст: Иван Петров\n\n**Тип:** Person\n...",
  "token_count": 1850,
  "sources": { "interactions_used": 5, "messages_analyzed": 127, "facts_included": 8 },
  "generated_at": "2025-01-07T16:00:00Z"
}
```

---

### POST /search

Поиск по истории взаимодействий.

**Request:**
```json
{
  "query": "бюджет проекта интеграции",
  "entity_id": "entity-uuid",
  "period": { "from": "2024-12-01", "to": "2025-01-07" },
  "search_type": "hybrid",
  "limit": 20
}
```

**Response 200:**
```json
{
  "results": [{
    "type": "message",
    "id": "msg-uuid",
    "content": "Бюджет на интеграцию согласован - 150 000 рублей",
    "timestamp": "2025-01-05T14:30:00Z",
    "entity": { "id": "entity-uuid", "name": "Иван Петров" },
    "interaction_id": "interaction-uuid",
    "score": 0.92,
    "highlight": "**Бюджет** на **интеграцию** согласован..."
  }],
  "total": 2,
  "search_type": "hybrid"
}
```

---

### GET /pending-resolutions

Получение списка pending entity resolutions.

**Query:** `?status=pending&limit=50`

**Response 200:**
```json
{
  "items": [{
    "id": "pending-uuid",
    "identifier_type": "telegram_user_id",
    "identifier_value": "99999999",
    "display_name": "Неизвестный Контакт",
    "status": "pending",
    "first_seen_at": "2025-01-06T10:00:00Z",
    "message_count": 5,
    "suggestions": [{ "entity_id": "entity-uuid", "name": "Иван Петров", "confidence": 0.65, "reason": "Похожий стиль" }]
  }],
  "total": 3
}
```

---

### POST /pending-resolutions/{id}/resolve

Ручное разрешение.

**Request:** `{ "entity_id": "entity-uuid" }`

**Response 200:**
```json
{
  "id": "pending-uuid",
  "status": "resolved",
  "entity_id": "entity-uuid",
  "messages_updated": 5,
  "resolved_at": "2025-01-07T16:00:00Z"
}
```

---

### POST /pending-resolutions/{id}/create-new

Создание нового entity из pending.

**Request:** `{ "name": "Новый Контакт", "type": "person" }`

**Response 201:**
```json
{
  "pending_resolution_id": "pending-uuid",
  "status": "resolved",
  "entity": { "id": "new-entity-uuid", "name": "Новый Контакт", "type": "person" },
  "messages_updated": 5
}
```

---

## Webhooks (PKG Core → Worker)

### Voice Transcription
**URL:** `POST http://n8n:5678/webhook/voice-transcription`

```json
{
  "job_id": "job-uuid",
  "type": "voice_transcription",
  "file_path": "/data/files/voice/tg_1000.ogg",
  "source": "telegram",
  "metadata": { "telegram_chat_id": "12345678", "duration_seconds": 45 },
  "callback_url": "http://pkg-core:3000/api/v1/internal/jobs/job-uuid/complete"
}
```

### Phone Call Processing
**URL:** `POST http://n8n:5678/webhook/phone-call-processing`

```json
{
  "job_id": "job-uuid",
  "type": "phone_call_processing",
  "interaction_id": "interaction-uuid",
  "file_path": "/data/files/calls/call_123.mp3",
  "metadata": { "phone_number": "+79161234567", "direction": "outgoing", "duration_seconds": 320 },
  "callback_url": "http://pkg-core:3000/api/v1/internal/jobs/job-uuid/complete"
}
```

### Context Synthesis
**URL:** `POST http://n8n:5678/webhook/context-synthesis`

```json
{
  "request_id": "req-uuid",
  "entity_id": "entity-uuid",
  "task_hint": "подготовка к звонку",
  "data": { "entity": {}, "facts": [], "recent_interactions": [], "recent_messages": [] },
  "callback_url": "http://pkg-core:3000/api/v1/internal/context/req-uuid/complete"
}
```

---

## Chat Categories API

### GET /chat-categories

Получение списка категоризированных чатов.

**Query:** `?category=working&limit=50&offset=0`

**Response 200:**
```json
{
  "items": [{
    "id": "uuid",
    "telegramChatId": "channel_1234567890",
    "category": "working",
    "title": "Рабочая группа",
    "participantsCount": 15,
    "autoExtractionEnabled": true,
    "isForum": false,
    "createdAt": "2025-01-07T10:00:00Z",
    "updatedAt": "2025-01-07T15:30:00Z"
  }],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

---

### GET /chat-categories/{telegramChatId}

Получение информации о конкретном чате.

**Response 200:**
```json
{
  "id": "uuid",
  "telegramChatId": "channel_1234567890",
  "category": "working",
  "title": "Рабочая группа",
  "participantsCount": 15,
  "autoExtractionEnabled": true,
  "isForum": true,
  "createdAt": "2025-01-07T10:00:00Z"
}
```

---

### PUT /chat-categories/{telegramChatId}

Изменение категории чата вручную.

**Request:**
```json
{
  "category": "personal"
}
```

**Response 200:**
```json
{
  "id": "uuid",
  "telegramChatId": "channel_1234567890",
  "category": "personal",
  "title": "Рабочая группа",
  "participantsCount": 15,
  "autoExtractionEnabled": true,
  "isManualOverride": true,
  "updatedAt": "2025-01-07T16:00:00Z"
}
```

**Примечание:**
- При изменении категории существующие Entity не удаляются
- Изменение влияет только на обработку новых сообщений
- Устанавливается флаг `isManualOverride: true`, который предотвращает автоматическую перекатегоризацию при изменении числа участников

---

### POST /chat-categories/{telegramChatId}/reset-override

Сброс флага ручного переопределения. После сброса категория будет автоматически обновляться при изменении числа участников.

**Response 200:**
```json
{
  "id": "uuid",
  "telegramChatId": "channel_1234567890",
  "category": "working",
  "isManualOverride": false,
  "updatedAt": "2025-01-07T16:00:00Z"
}
```

**Response 404:** Чат не найден

---

### POST /chat-categories/{telegramChatId}/refresh

Обновление информации о чате из Telegram (title, participantsCount, isForum).

**Response 200:**
```json
{
  "id": "uuid",
  "telegramChatId": "channel_1234567890",
  "category": "working",
  "title": "Обновлённое название",
  "participantsCount": 18,
  "isForum": true,
  "updatedAt": "2025-01-07T16:00:00Z"
}
```

---

## Media Proxy API (PKG Core)

**Base URL:** `http://pkg-core:3000/api/v1`

> **Архитектурное примечание:** Все клиенты (Dashboard, мобильное приложение и т.д.) должны получать медиа через PKG Core, а не напрямую через Telegram Adapter. Это обеспечивает source-agnostic архитектуру.

### GET /media/{chatId}/{messageId}

Стриминг медиа-файла. PKG Core проксирует запрос к Telegram Adapter.

**Parameters:**
- `chatId` — ID чата (channel_xxx, user_xxx, chat_xxx)
- `messageId` — source_message_id сообщения

**Query:**
- `size` — размер фото: `s` (small), `m` (medium), `x` (large). По умолчанию: `x`
- `thumb` — `true` для получения превью документа/видео

**Response 200:**
- `Content-Type`: соответствует типу файла (image/jpeg, video/mp4, audio/ogg, etc.)
- `Content-Length`: размер файла в байтах
- `Content-Disposition`: для документов с filename
- Body: бинарные данные файла (streaming)

**Response 404:**
- Сообщение не найдено или медиа отсутствует

**Пример:**
```
GET /api/v1/media/channel_1234567890/999?size=x
→ JPEG image stream

GET /api/v1/media/user_87654321/1000?thumb=true
→ Video thumbnail JPEG stream
```

---

### GET /media/chat/{chatId}/info

Получение информации о чате из Telegram (title, participantsCount, isForum).

**Response 200:**
```json
{
  "title": "Название чата",
  "participantsCount": 15,
  "isForum": false
}
```

---

## Media Download API (Telegram Adapter) — Internal

**Base URL:** `http://telegram-adapter:3001/api/v1`

> ⚠️ **ВАЖНО:** Это внутренний API. Клиенты должны использовать Media Proxy API в PKG Core, а не обращаться к Telegram Adapter напрямую.

### GET /chats/{chatId}/messages/{messageId}/download

Стриминг медиа-файла из Telegram через MTProto.

**Parameters:**
- `chatId` — ID чата (channel_xxx, user_xxx, chat_xxx)
- `messageId` — source_message_id сообщения

**Query:**
- `size` — размер фото: `s` (small), `m` (medium), `x` (large). По умолчанию: `x`
- `thumb` — `true` для получения превью документа/видео

**Response 200:**
- `Content-Type`: соответствует типу файла (image/jpeg, video/mp4, audio/ogg, etc.)
- `Content-Length`: размер файла в байтах
- `Content-Disposition`: для документов с filename
- Body: бинарные данные файла (streaming)

---

## Settings API

### GET /settings

Получение всех настроек системы.

**Response:**
```json
[
  {
    "key": "session.gapThresholdMinutes",
    "value": 240,
    "description": "Порог разделения сессий в минутах",
    "category": "session"
  },
  {
    "key": "extraction.minConfidence",
    "value": 0.6,
    "description": "Минимальная уверенность для извлечённых фактов",
    "category": "extraction"
  }
]
```

### GET /settings/{key}

Получение конкретной настройки.

**Response:**
```json
{
  "key": "session.gapThresholdMinutes",
  "value": 240,
  "description": "Порог разделения сессий в минутах",
  "category": "session"
}
```

### PUT /settings/{key}

Обновление настройки.

**Request:**
```json
{
  "value": 120
}
```

**Валидация для `session.gapThresholdMinutes`:**
- Минимум: 15 минут
- Максимум: 1440 минут (24 часа)
- По умолчанию: 240 минут (4 часа)

**Response:** Обновлённая настройка

**Ошибки:**
- 400 Bad Request — значение вне допустимого диапазона

---

## Fact Conflicts API

API для управления конфликтами фактов, возникающими при Smart Fact Fusion.

### GET /fact-conflicts

Получение списка фактов, требующих ревью (конфликты).

**Query Parameters:**
| Параметр | Тип | По умолчанию | Описание |
|----------|-----|--------------|----------|
| `limit` | number | 50 | Максимум записей (1-100) |

**Response 200:**
```json
[
  {
    "id": "fact-uuid",
    "entityId": "entity-uuid",
    "factType": "position",
    "category": "professional",
    "value": "CTO в Сбербанке",
    "source": "extracted",
    "rank": "normal",
    "confidence": 0.85,
    "needsReview": true,
    "reviewReason": "Конфликт с новым фактом: \"Директор в Тинькофф\". Разные компании.",
    "confirmationCount": 1,
    "createdAt": "2025-01-15T10:00:00Z"
  }
]
```

---

### POST /fact-conflicts/:shortId/new

Разрешение конфликта: использовать новый факт.

Старый факт помечается как deprecated, новый создаётся как preferred.

**Parameters:**
- `shortId` — короткий ID конфликта из Redis

**Response 200:**
```json
{
  "success": true,
  "action": "used_new",
  "factId": "new-fact-uuid"
}
```

**Response 404:**
```json
{
  "success": false,
  "action": "kept_old",
  "error": "Данные не найдены или устарели"
}
```

---

### POST /fact-conflicts/:shortId/old

Разрешение конфликта: оставить старый факт.

Новый факт отклоняется, старый получает увеличение confirmationCount.

**Parameters:**
- `shortId` — короткий ID конфликта из Redis

**Response 200:**
```json
{
  "success": true,
  "action": "kept_old",
  "factId": "existing-fact-uuid"
}
```

---

### POST /fact-conflicts/:shortId/both

Разрешение конфликта: сохранить оба факта (COEXIST).

Оба факта остаются активными, подходит для случаев разных временных периодов.

**Parameters:**
- `shortId` — короткий ID конфликта из Redis

**Response 200:**
```json
{
  "success": true,
  "action": "created_both",
  "factId": "new-fact-uuid"
}
```

---

### Telegram Callback Format

Кнопки в Telegram используют сокращённые префиксы для callback_data:

| Callback | Описание |
|----------|----------|
| `f_n:<shortId>` | Использовать новый факт |
| `f_o:<shortId>` | Оставить старый факт |
| `f_b:<shortId>` | Сохранить оба факта |

Пример сообщения:
```
⚠️ Конфликт фактов

👤 Иван Петров
📋 Тип: position

Существующий:
"CTO в Сбербанке" (извлечено)
📅 Добавлен: 15.01.2025

Новый:
"Директор в Тинькофф" (извлечено)
📅 Извлечён: 20.01.2025

Какой факт корректен?

[✅ Новый] [❌ Старый] [🔀 Оба]
```

---

## Agent API (Recall Sessions)

API для работы с Recall сессиями — результатами AI-поиска по истории взаимодействий.

### POST /agent/recall

Поиск по истории взаимодействий на естественном языке.

**Request:**
```json
{
  "query": "что обсуждали с Иваном на прошлой неделе?",
  "entityId": "entity-uuid",
  "maxTurns": 15,
  "model": "sonnet",
  "userId": "864381617"
}
```

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `query` | string | Да | Поисковый запрос (мин. 3 символа) |
| `entityId` | uuid | Нет | Фильтр по конкретной entity |
| `maxTurns` | number | Нет | Макс. итераций агента (1-20, default: 15) |
| `model` | string | Нет | Модель Claude: haiku, sonnet, opus (default: sonnet) |
| `userId` | string | Нет | ID пользователя для multi-user safety |

**Response 200:**
```json
{
  "success": true,
  "data": {
    "sessionId": "rs_a1b2c3d4e5f6",
    "answer": "На прошлой неделе с Иваном обсуждали...",
    "sources": [
      {
        "type": "message",
        "id": "msg-uuid",
        "preview": "Иван: Давай созвонимся завтра..."
      }
    ],
    "toolsUsed": ["search_messages", "get_entity_context"]
  }
}
```

---

### GET /agent/recall/session/:sessionId

Получение данных сессии для follow-up операций.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `userId` | string | ID пользователя для верификации |

**Response 200:**
```json
{
  "success": true,
  "data": {
    "sessionId": "rs_a1b2c3d4e5f6",
    "query": "что обсуждали с Иваном?",
    "dateStr": "2025-01-30",
    "answer": "На прошлой неделе с Иваном...",
    "sources": [...],
    "model": "sonnet",
    "createdAt": 1706612400000
  }
}
```

**Response 403:** Unauthorized — userId не совпадает с владельцем сессии
**Response 404:** Session not found or expired

---

### POST /agent/recall/session/:sessionId/followup

Уточняющий вопрос в контексте существующей сессии.

**Request:**
```json
{
  "query": "А что насчёт дедлайнов?",
  "model": "sonnet",
  "userId": "864381617"
}
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "sessionId": "rs_a1b2c3d4e5f6",
    "answer": "Дедлайны были установлены на...",
    "sources": [...],
    "toolsUsed": ["search_messages"]
  }
}
```

**Response 403:** Unauthorized
**Response 404:** Session not found

---

### POST /agent/recall/session/:sessionId/save

Сохранение инсайтов сессии как факт (daily_summary).

**Атомарная операция:** PKG Core сам находит owner entity, создаёт fact в PostgreSQL, и помечает сессию как сохранённую. Идемпотентная операция — повторные вызовы возвращают существующий factId.

**Request:**
```json
{
  "userId": "864381617"
}
```

**Response 200 (первое сохранение):**
```json
{
  "success": true,
  "alreadySaved": false,
  "factId": "fact-uuid-from-postgresql"
}
```

**Response 200 (повторный вызов):**
```json
{
  "success": true,
  "alreadySaved": true,
  "factId": "fact-uuid-from-postgresql"
}
```

**Response 200 (ошибка):**
```json
{
  "success": false,
  "error": "Owner entity not configured. Please set an owner entity first."
}
```

**Response 403:** Unauthorized
**Response 404:** Session not found

**Создаваемый факт:**
- `type`: daily_summary
- `category`: personal
- `value`: краткое превью (до 500 символов)
- `valueJson`: { fullContent, dateStr, sessionId, query }
- `source`: extracted
- `confidence`: 1.0

---

### POST /agent/recall/session/:sessionId/extract

Извлечение структурированных данных из сессии (проекты, задачи, обязательства).

**Request:**
```json
{
  "focusTopic": "Панавто",
  "model": "sonnet",
  "userId": "864381617"
}
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "projects": [...],
    "tasks": [...],
    "commitments": [...],
    "inferredRelations": [...],
    "extractionSummary": "Извлечено 2 проекта...",
    "tokensUsed": 1500,
    "durationMs": 3200
  }
}
```

---

## Activity API

REST API для управления активностями (Activity). Активности — иерархическая модель всех "дел" человека: от сфер жизни (AREA) до конкретных задач (TASK).

### Enums

**ActivityType:**
| Значение | Описание |
|----------|----------|
| `area` | Сфера жизни (Работа, Семья, Здоровье) |
| `business` | Бизнес/организация |
| `direction` | Направление деятельности внутри бизнеса |
| `project` | Проект с целью и сроками |
| `initiative` | Инициатива/эпик внутри проекта |
| `task` | Конкретная задача |
| `milestone` | Веха/milestone |
| `habit` | Повторяющаяся привычка |
| `learning` | Обучение/курс |
| `event_series` | Серия событий (еженедельные встречи) |

**ActivityStatus:**
| Значение | Описание |
|----------|----------|
| `draft` | Черновик — ожидает подтверждения |
| `idea` | Идея, не начата |
| `active` | Активна, в работе |
| `paused` | На паузе |
| `completed` | Завершена успешно |
| `cancelled` | Отменена |
| `archived` | В архиве |

**ActivityPriority:** `critical`, `high`, `medium`, `low`, `none`

**ActivityContext:** `work`, `personal`, `any`, `location_based`

**ActivityMemberRole:** `owner`, `member`, `observer`, `assignee`, `reviewer`, `client`, `consultant`

---

### POST /activities

Создать новую Activity. Если передан `parentId` — валидирует иерархию типов. Если передан `participants` — резолвит и создаёт ActivityMember записи.

**Request:**
```json
{
  "name": "Разработка CRM для клиента",
  "activityType": "project",
  "description": "Разработка CRM системы с интеграцией Битрикс24",
  "status": "active",
  "priority": "high",
  "context": "work",
  "parentId": "parent-activity-uuid",
  "ownerEntityId": "owner-entity-uuid",
  "clientEntityId": "client-entity-uuid",
  "deadline": "2025-06-01T00:00:00Z",
  "startDate": "2025-02-01T00:00:00Z",
  "recurrenceRule": null,
  "tags": ["crm", "bitrix"],
  "progress": 0,
  "metadata": { "budget": 150000 }
}
```

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `name` | string | Да | Название (макс. 500 символов) |
| `activityType` | ActivityType | Да | Тип активности |
| `description` | string | Нет | Подробное описание |
| `status` | ActivityStatus | Нет | Статус (по умолчанию `active`) |
| `priority` | ActivityPriority | Нет | Приоритет (по умолчанию `medium`) |
| `context` | ActivityContext | Нет | Контекст (по умолчанию `any`) |
| `parentId` | uuid | Нет | ID родительской Activity |
| `ownerEntityId` | uuid | Да | ID владельца (Entity) |
| `clientEntityId` | uuid | Нет | ID клиента (Entity) |
| `deadline` | ISO 8601 | Нет | Дедлайн |
| `startDate` | ISO 8601 | Нет | Дата начала |
| `recurrenceRule` | string | Нет | Cron-выражение для повторяющихся (макс. 100 символов) |
| `tags` | string[] | Нет | Теги для фильтрации |
| `progress` | number | Нет | Прогресс 0-100 |
| `metadata` | object | Нет | Дополнительные метаданные |

**Response 201:**
```json
{
  "id": "activity-uuid",
  "name": "Разработка CRM для клиента",
  "activityType": "project",
  "description": "Разработка CRM системы с интеграцией Битрикс24",
  "status": "active",
  "priority": "high",
  "context": "work",
  "parentId": "parent-activity-uuid",
  "ownerEntityId": "owner-entity-uuid",
  "clientEntityId": "client-entity-uuid",
  "deadline": "2025-06-01T00:00:00.000Z",
  "startDate": "2025-02-01T00:00:00.000Z",
  "endDate": null,
  "recurrenceRule": null,
  "tags": ["crm", "bitrix"],
  "progress": 0,
  "metadata": { "budget": 150000 },
  "depth": 1,
  "materializedPath": "parent-activity-uuid/activity-uuid",
  "lastActivityAt": null,
  "createdAt": "2025-02-06T10:00:00.000Z",
  "updatedAt": "2025-02-06T10:00:00.000Z",
  "deletedAt": null
}
```

**Response 400:** Невалидные данные (нарушение иерархии типов, неверный parentId)

---

### GET /activities

Список активностей с фильтрами и пагинацией.

**Query Parameters:**
| Параметр | Тип | По умолчанию | Описание |
|----------|-----|--------------|----------|
| `activityType` | ActivityType | — | Фильтр по типу |
| `status` | ActivityStatus | — | Фильтр по статусу |
| `context` | ActivityContext | — | Фильтр по контексту |
| `parentId` | uuid | — | Фильтр по родителю |
| `ownerEntityId` | uuid | — | Фильтр по владельцу |
| `clientEntityId` | uuid | — | Фильтр по клиенту |
| `search` | string | — | Поиск по названию (ILIKE, макс. 200 символов) |
| `limit` | number | 50 | Макс. записей (1-200) |
| `offset` | number | 0 | Смещение для пагинации |

**Пример:** `GET /activities?activityType=project&status=active&ownerEntityId=uuid&limit=20`

**Response 200:**
```json
{
  "items": [
    {
      "id": "activity-uuid",
      "name": "Разработка CRM для клиента",
      "activityType": "project",
      "description": "Разработка CRM системы",
      "status": "active",
      "priority": "high",
      "context": "work",
      "parentId": null,
      "ownerEntityId": "owner-entity-uuid",
      "ownerEntity": { "id": "owner-entity-uuid", "name": "Дмитрий", "type": "person" },
      "clientEntityId": "client-entity-uuid",
      "clientEntity": { "id": "client-entity-uuid", "name": "ООО Панавто", "type": "organization" },
      "deadline": "2025-06-01T00:00:00.000Z",
      "startDate": "2025-02-01T00:00:00.000Z",
      "endDate": null,
      "tags": ["crm", "bitrix"],
      "progress": 25,
      "createdAt": "2025-02-06T10:00:00.000Z",
      "updatedAt": "2025-02-06T12:00:00.000Z"
    }
  ],
  "total": 42
}
```

---

### GET /activities/:id

Детали активности по ID. Возвращает Activity с relations (parent, ownerEntity, clientEntity), members и количеством children.

**Parameters:**
- `id` (uuid) — ID активности

**Response 200:**
```json
{
  "id": "activity-uuid",
  "name": "Разработка CRM для клиента",
  "activityType": "project",
  "description": "Разработка CRM системы с интеграцией Битрикс24",
  "status": "active",
  "priority": "high",
  "context": "work",
  "parentId": null,
  "parent": null,
  "ownerEntityId": "owner-entity-uuid",
  "ownerEntity": { "id": "owner-entity-uuid", "name": "Дмитрий", "type": "person" },
  "clientEntityId": "client-entity-uuid",
  "clientEntity": { "id": "client-entity-uuid", "name": "ООО Панавто", "type": "organization" },
  "deadline": "2025-06-01T00:00:00.000Z",
  "startDate": "2025-02-01T00:00:00.000Z",
  "endDate": null,
  "recurrenceRule": null,
  "tags": ["crm", "bitrix"],
  "progress": 25,
  "metadata": { "budget": 150000 },
  "depth": 0,
  "materializedPath": "activity-uuid",
  "lastActivityAt": "2025-02-06T12:00:00.000Z",
  "createdAt": "2025-02-06T10:00:00.000Z",
  "updatedAt": "2025-02-06T12:00:00.000Z",
  "deletedAt": null,
  "childrenCount": 5,
  "members": [
    {
      "id": "member-uuid",
      "activityId": "activity-uuid",
      "entityId": "entity-uuid",
      "entity": { "id": "entity-uuid", "name": "Иван Петров", "type": "person" },
      "role": "member",
      "notes": "Backend разработчик",
      "isActive": true,
      "joinedAt": "2025-02-06T10:00:00.000Z",
      "leftAt": null,
      "metadata": null,
      "createdAt": "2025-02-06T10:00:00.000Z",
      "updatedAt": "2025-02-06T10:00:00.000Z"
    }
  ]
}
```

**Response 404:** Activity not found

---

### PATCH /activities/:id

Обновить поля активности. Все поля опциональны. Если меняется `parentId` — валидирует иерархию и отсутствие циклов.

**Parameters:**
- `id` (uuid) — ID активности

**Request:**
```json
{
  "name": "CRM для Панавто v2",
  "status": "paused",
  "priority": "critical",
  "progress": 50,
  "deadline": "2025-07-01T00:00:00Z",
  "tags": ["crm", "bitrix", "urgent"]
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `name` | string | Название (макс. 500 символов) |
| `activityType` | ActivityType | Тип активности |
| `description` | string \| null | Описание (null для очистки) |
| `status` | ActivityStatus | Статус |
| `priority` | ActivityPriority | Приоритет |
| `context` | ActivityContext | Контекст |
| `parentId` | uuid \| null | ID родителя (null для перемещения в корень) |
| `ownerEntityId` | uuid | ID владельца |
| `clientEntityId` | uuid \| null | ID клиента (null для очистки) |
| `deadline` | ISO 8601 \| null | Дедлайн |
| `startDate` | ISO 8601 \| null | Дата начала |
| `endDate` | ISO 8601 \| null | Дата завершения |
| `recurrenceRule` | string \| null | Cron-выражение |
| `tags` | string[] \| null | Теги |
| `progress` | number \| null | Прогресс 0-100 |
| `metadata` | object \| null | Метаданные |

**Response 200:** Обновлённая Activity (тот же формат, что и GET /activities/:id, без members/childrenCount)

**Response 400:** Невалидные данные или нарушение иерархии
**Response 404:** Activity not found

---

### DELETE /activities/:id

Soft delete — устанавливает `status = ARCHIVED`. Данные сохраняются, активность скрывается из активных списков.

**Parameters:**
- `id` (uuid) — ID активности

**Response 200:**
```json
{
  "id": "activity-uuid",
  "status": "archived",
  "message": "Activity archived successfully"
}
```

**Response 404:** Activity not found

---

### GET /activities/:id/tree

Получить поддерево активности (children + all descendants).

**Parameters:**
- `id` (uuid) — ID корневой активности

**Response 200:**
```json
[
  {
    "id": "child-uuid-1",
    "name": "Этап 1: Анализ",
    "activityType": "initiative",
    "status": "completed",
    "parentId": "activity-uuid",
    "depth": 1,
    "children": [
      {
        "id": "grandchild-uuid-1",
        "name": "Провести интервью",
        "activityType": "task",
        "status": "completed",
        "parentId": "child-uuid-1",
        "depth": 2,
        "children": []
      }
    ]
  },
  {
    "id": "child-uuid-2",
    "name": "Этап 2: Разработка",
    "activityType": "initiative",
    "status": "active",
    "parentId": "activity-uuid",
    "depth": 1,
    "children": []
  }
]
```

**Response 404:** Activity not found

---

### POST /activities/:id/members

Добавить участников к активности. Дубликаты (по entityId + role) пропускаются.

**Parameters:**
- `id` (uuid) — ID активности

**Request:**
```json
{
  "members": [
    {
      "entityId": "entity-uuid-1",
      "role": "member",
      "notes": "Backend разработчик"
    },
    {
      "entityId": "entity-uuid-2",
      "role": "reviewer"
    }
  ]
}
```

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `members` | array | Да | Массив участников (1-50 элементов) |
| `members[].entityId` | uuid | Да | ID сущности (Entity) |
| `members[].role` | ActivityMemberRole | Нет | Роль (по умолчанию `member`) |
| `members[].notes` | string | Нет | Заметки о роли |

**Response 201:**
```json
{
  "added": 2,
  "skipped": 0,
  "members": [
    {
      "id": "member-uuid-1",
      "activityId": "activity-uuid",
      "entityId": "entity-uuid-1",
      "role": "member",
      "notes": "Backend разработчик",
      "isActive": true,
      "joinedAt": "2025-02-06T10:00:00.000Z",
      "createdAt": "2025-02-06T10:00:00.000Z"
    },
    {
      "id": "member-uuid-2",
      "activityId": "activity-uuid",
      "entityId": "entity-uuid-2",
      "role": "reviewer",
      "notes": null,
      "isActive": true,
      "joinedAt": "2025-02-06T10:00:00.000Z",
      "createdAt": "2025-02-06T10:00:00.000Z"
    }
  ]
}
```

**Response 404:** Activity not found

---

### GET /activities/:id/members

Получить участников активности (только активных, отсортированных по роли и дате вступления).

**Parameters:**
- `id` (uuid) — ID активности

**Response 200:**
```json
[
  {
    "id": "member-uuid",
    "activityId": "activity-uuid",
    "entityId": "entity-uuid",
    "entity": { "id": "entity-uuid", "name": "Иван Петров", "type": "person" },
    "role": "member",
    "notes": "Backend разработчик",
    "isActive": true,
    "joinedAt": "2025-02-06T10:00:00.000Z",
    "leftAt": null,
    "metadata": null,
    "createdAt": "2025-02-06T10:00:00.000Z",
    "updatedAt": "2025-02-06T10:00:00.000Z"
  }
]
```

**Response 404:** Activity not found

---

## Data Quality API

REST API для аудита качества данных, обнаружения проблем (дубликаты, сироты, пропущенные связи) и их разрешения.

### Enums

**DataQualityReportStatus:**
| Значение | Описание |
|----------|----------|
| `PENDING` | Отчёт создан, проблемы не рассмотрены |
| `REVIEWED` | Часть проблем разрешена |
| `RESOLVED` | Все проблемы разрешены |

**DataQualityIssueType:**
| Значение | Описание |
|----------|----------|
| `DUPLICATE` | Дубликат активности (одинаковое имя + тип) |
| `ORPHAN` | Задача без валидного родителя |
| `MISSING_CLIENT` | PROJECT/BUSINESS без клиента |
| `MISSING_MEMBERS` | Активность без участников |
| `UNLINKED_COMMITMENT` | Обязательство без привязки к Activity |
| `EMPTY_FIELDS` | Незаполненные ключевые поля |

**DataQualityIssueSeverity:** `HIGH`, `MEDIUM`, `LOW`

---

### POST /data-quality/audit

Запуск полного аудита качества данных. Собирает метрики, обнаруживает проблемы и сохраняет DataQualityReport в БД.

**Response 201:**
```json
{
  "id": "report-uuid",
  "reportDate": "2025-02-06T10:00:00.000Z",
  "metrics": {
    "totalActivities": 42,
    "duplicateGroups": 3,
    "orphanedTasks": 5,
    "missingClientEntity": 8,
    "activityMemberCoverage": 0.65,
    "commitmentLinkageRate": 0.72,
    "inferredRelationsCount": 12,
    "fieldFillRate": 0.45
  },
  "issues": [
    {
      "type": "DUPLICATE",
      "severity": "HIGH",
      "activityId": "activity-uuid",
      "activityName": "CRM для Панавто",
      "description": "Duplicate of \"CRM для Панавто\" (2 total with same name and type \"project\")",
      "suggestedAction": "Merge with activity original-uuid using merge_activities tool"
    },
    {
      "type": "ORPHAN",
      "severity": "MEDIUM",
      "activityId": "task-uuid",
      "activityName": "Настроить CI/CD",
      "description": "Task has no valid parent activity",
      "suggestedAction": "Assign to appropriate parent project or initiative"
    },
    {
      "type": "MISSING_CLIENT",
      "severity": "LOW",
      "activityId": "project-uuid",
      "activityName": "Внутренний портал",
      "description": "project without client entity",
      "suggestedAction": "Link to client entity or mark as internal"
    }
  ],
  "resolutions": null,
  "status": "PENDING",
  "createdAt": "2025-02-06T10:00:00.000Z",
  "updatedAt": "2025-02-06T10:00:00.000Z"
}
```

---

### GET /data-quality/reports

Список отчётов о качестве данных с пагинацией.

**Query Parameters:**
| Параметр | Тип | По умолчанию | Описание |
|----------|-----|--------------|----------|
| `limit` | number | 20 | Макс. записей |
| `offset` | number | 0 | Смещение для пагинации |

**Response 200:**
```json
{
  "data": [
    {
      "id": "report-uuid",
      "reportDate": "2025-02-06T10:00:00.000Z",
      "metrics": { "..." },
      "issues": [ "..." ],
      "resolutions": null,
      "status": "PENDING",
      "createdAt": "2025-02-06T10:00:00.000Z",
      "updatedAt": "2025-02-06T10:00:00.000Z"
    }
  ],
  "total": 5
}
```

---

### GET /data-quality/reports/latest

Получить последний отчёт о качестве данных.

**Response 200:** DataQualityReport (тот же формат, что и POST /data-quality/audit)

**Response 404:** No data quality reports found

---

### GET /data-quality/reports/:id

Получить конкретный отчёт по ID.

**Parameters:**
- `id` (uuid) -- ID отчёта

**Response 200:** DataQualityReport (тот же формат)

**Response 404:** DataQualityReport not found

---

### PATCH /data-quality/reports/:id/resolve

Разрешить проблему в отчёте. Добавляет запись о разрешении. Если все проблемы разрешены -- статус отчёта меняется на `RESOLVED`.

**Parameters:**
- `id` (uuid) -- ID отчёта

**Request (ResolveIssueDto):**
```json
{
  "issueIndex": 0,
  "action": "Merged with original activity via merge_activities"
}
```

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `issueIndex` | number | Да | Индекс проблемы в массиве issues (начиная с 0) |
| `action` | string | Да | Описание предпринятого действия (макс. 500 символов) |

**Response 200:**
```json
{
  "id": "report-uuid",
  "status": "REVIEWED",
  "resolutions": [
    {
      "issueIndex": 0,
      "resolvedAt": "2025-02-06T12:00:00.000Z",
      "resolvedBy": "manual",
      "action": "Merged with original activity via merge_activities"
    }
  ],
  "..."
}
```

**Response 404:** Report not found or issue index out of range

---

### GET /data-quality/metrics

Получить текущие метрики качества данных без сохранения отчёта.

**Response 200:**
```json
{
  "totalActivities": 42,
  "duplicateGroups": 3,
  "orphanedTasks": 5,
  "missingClientEntity": 8,
  "activityMemberCoverage": 0.65,
  "commitmentLinkageRate": 0.72,
  "inferredRelationsCount": 12,
  "fieldFillRate": 0.45
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `totalActivities` | number | Общее количество активных Activity |
| `duplicateGroups` | number | Количество групп дубликатов |
| `orphanedTasks` | number | Количество задач без валидного родителя |
| `missingClientEntity` | number | PROJECT/BUSINESS без клиента |
| `activityMemberCoverage` | number | Доля Activity с хотя бы одним участником (0-1) |
| `commitmentLinkageRate` | number | Доля Commitments с привязкой к Activity (0-1) |
| `inferredRelationsCount` | number | Количество EntityRelations с source = EXTRACTED/INFERRED |
| `fieldFillRate` | number | Средняя заполненность ключевых полей (0-1) |

---

### POST /data-quality/merge

Мерж дубликатов активностей в одну. Переносит children, members и commitments на целевую активность, а исходные архивирует.

**Request (MergeActivitiesDto):**
```json
{
  "keepId": "activity-uuid-to-keep",
  "mergeIds": ["duplicate-uuid-1", "duplicate-uuid-2"]
}
```

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `keepId` | uuid | Да | ID активности, которую сохранить |
| `mergeIds` | uuid[] | Да | ID активностей для слияния (1-20 элементов) |

**Стратегия мержа:**
1. Перенос children с merged активностей на keepId
2. Перенос members (пропуск дубликатов по entityId + role)
3. Перепривязка commitments на keepId
4. Soft-delete merged активностей (status = ARCHIVED)

**Response 200:** Обновлённая Activity (та, которую сохранили)

**Response 404:** Activity to keep or merge activities not found

---

### POST /data-quality/auto-merge-duplicates

Автоматическое объединение всех обнаруженных дубликатов. Выбирает лучшего "хранителя" в каждой группе по критериям: больше children -> members -> старший по createdAt.

**Response:**
```json
{
  "mergedGroups": 3,
  "totalMerged": 7,
  "errors": [],
  "details": [
    {
      "keptId": "uuid",
      "keptName": "Project Alpha",
      "mergedIds": ["uuid1", "uuid2"]
    }
  ]
}
```

---

### POST /data-quality/auto-assign-orphans

Автоматическое назначение orphaned tasks (без parentId) к подходящим проектам. Стратегии (по приоритету): name containment -> batch -> single project -> "Unsorted Tasks".

**Response:**
```json
{
  "resolved": 75,
  "unresolved": 13,
  "createdUnsortedProject": true,
  "details": [
    {
      "taskId": "uuid",
      "taskName": "Fix bug",
      "assignedParentId": "uuid",
      "assignedParentName": "Project Alpha",
      "method": "name_containment"
    }
  ]
}
```

---

### POST /data-quality/auto-resolve-clients

Автоматическое определение клиентов для PROJECT/BUSINESS activities без client entity. Использует 3-стратегийное определение: explicit name -> participant org -> name search.

**Response:**
```json
{
  "resolved": 5,
  "unresolved": 2,
  "details": [
    {
      "activityId": "uuid",
      "activityName": "Project Alpha",
      "clientEntityId": "uuid",
      "clientName": "Acme Corp",
      "method": "participant_org"
    }
  ]
}
```

---

### AI Agent Tools

Data Quality System предоставляет 5 AI agent tools для Claude:

| Tool | Описание |
|------|----------|
| `run_data_quality_audit` | Запуск полного аудита с сохранением отчёта |
| `find_duplicate_projects` | Поиск дубликатов по нормализованному имени |
| `merge_activities` | Мерж дубликатов (keepId + mergeIds) |
| `find_orphaned_tasks` | Поиск задач без валидного родителя |
| `get_data_quality_report` | Получение последнего или конкретного отчёта |

---

## Segmentation API

API для тематической сегментации обсуждений и управления KnowledgePack.

### POST /segments

Создание нового тематического сегмента.

**Request Body:**
```json
{
  "topic": "Обсуждение дедлайнов проекта Alpha",
  "keywords": ["дедлайн", "сроки", "Alpha"],
  "summary": "Обсуждение переноса дедлайнов на следующую неделю",
  "chatId": "telegram:-1001234567890",
  "interactionId": "uuid",
  "activityId": "uuid",
  "participantIds": ["uuid", "uuid"],
  "primaryParticipantId": "uuid",
  "messageIds": ["uuid", "uuid"],
  "startedAt": "2026-02-01T10:00:00Z",
  "endedAt": "2026-02-01T10:30:00Z",
  "confidence": 0.85
}
```

**Response:** `201 Created` — объект созданного сегмента.

---

### GET /segments

Список сегментов с фильтрами и пагинацией.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `chatId` | string | Фильтр по идентификатору чата |
| `activityId` | uuid | Фильтр по Activity |
| `interactionId` | uuid | Фильтр по Interaction |
| `status` | SegmentStatus | Фильтр по статусу (`DRAFT`, `ACTIVE`, `CLOSED`, `MERGED`) |
| `search` | string | Полнотекстовый поиск по topic/keywords/summary |
| `limit` | number | Максимум записей (default: 20, max: 100) |
| `offset` | number | Смещение (default: 0) |

**Response:** `200 OK`
```json
{
  "items": [...],
  "total": 42
}
```

---

### GET /segments/:id

Получение одного сегмента по ID.

**Response:** `200 OK` — объект сегмента.

| Status | Описание |
|--------|----------|
| 200 | Сегмент найден |
| 404 | Сегмент не найден |

---

### PATCH /segments/:id

Обновление сегмента.

**Request Body:**
```json
{
  "topic": "Обновлённая тема",
  "keywords": ["новые", "ключевые", "слова"],
  "summary": "Обновлённое описание",
  "activityId": "uuid или null",
  "status": "CLOSED",
  "confidence": 0.95
}
```

Все поля опциональны.

**Response:** `200 OK` — обновлённый объект сегмента.

---

### GET /segments/:id/messages

Получение сообщений, привязанных к сегменту.

**Response:** `200 OK` — массив сообщений.

---

### POST /segments/:id/messages

Привязка сообщений к сегменту.

**Request Body:**
```json
{
  "messageIds": ["uuid1", "uuid2", "uuid3"]
}
```

**Response:** `200 OK`
```json
{
  "linked": 3
}
```

---

### POST /segments/:id/merge

Объединение двух сегментов. Все сообщения и метаданные sourceSegment переносятся в target.

**Request Body:**
```json
{
  "sourceSegmentId": "uuid"
}
```

**Response:** `200 OK` — объединённый сегмент.

---

### GET /segments/:id/related

Поиск связанных сегментов из других чатов по тематическому сходству.

**Response:** `200 OK` — массив связанных сегментов.

---

### POST /segments/:id/link-related

Связывание сегмента с тематически близкими сегментами из других чатов.

**Request Body:**
```json
{
  "relatedSegmentIds": ["uuid1", "uuid2"]
}
```

**Response:** `200 OK`
```json
{
  "linked": 2
}
```

---

### POST /segments/detect

Автоматическое определение границ тем в наборе сообщений и создание сегментов.

**Request Body:**
```json
{
  "chatId": "telegram:-1001234567890",
  "interactionId": "uuid",
  "messages": [
    {
      "id": "uuid",
      "content": "Текст сообщения",
      "timestamp": "2026-02-01T10:00:00Z",
      "isOutgoing": false,
      "senderEntityName": "Иван"
    }
  ],
  "participantIds": ["uuid"],
  "primaryParticipantId": "uuid",
  "chatTitle": "Рабочий чат",
  "activityId": "uuid"
}
```

**Response:** `200 OK` — результат детектирования и созданные сегменты.

---

### POST /segments/run-segmentation

Ручной запуск задачи автосегментации. Запускается в фоне (fire-and-forget).

**Response:** `200 OK`
```json
{
  "status": "started",
  "message": "Segmentation job triggered. Check logs for progress."
}
```

---

### POST /segments/run-orphan-linker

Ручной запуск привязки осиротевших сегментов к Activity.

**Response:** `200 OK`
```json
{
  "status": "completed",
  "linked": 5,
  "skipped": 2,
  "errors": 0
}
```

---

### GET /segments/packs/list

Список KnowledgePack с фильтрами.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `activityId` | uuid | Фильтр по Activity |
| `entityId` | uuid | Фильтр по Entity |
| `packType` | string | Тип пакета |
| `limit` | number | Максимум записей (default: 20) |
| `offset` | number | Смещение (default: 0) |

**Response:** `200 OK` — список KnowledgePack.

---

### GET /segments/packs/:id

Получение одного KnowledgePack по ID.

**Response:** `200 OK` — объект KnowledgePack.

---

### POST /segments/packs/create-for-activity

Консолидация всех ACTIVE/CLOSED сегментов для Activity в один KnowledgePack.

**Request Body:**
```json
{
  "activityId": "uuid",
  "title": "Опциональный заголовок"
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "data": {
    "packId": "uuid",
    "title": "Activity: Project Alpha",
    "segmentCount": 5,
    "totalMessageCount": 120,
    "tokensUsed": 4500,
    "durationMs": 3200
  }
}
```

---

### POST /segments/packs/create-for-entity

Консолидация всех ACTIVE/CLOSED сегментов для Entity (как primary participant) в KnowledgePack.

**Request Body:**
```json
{
  "entityId": "uuid",
  "title": "Опциональный заголовок"
}
```

**Response:** `200 OK` — аналогично `create-for-activity`.

---

### POST /segments/packs/create-for-period

Консолидация сегментов за временной период в KnowledgePack.

**Request Body:**
```json
{
  "chatId": "telegram:-1001234567890",
  "startDate": "2026-02-01",
  "endDate": "2026-02-07",
  "title": "Опциональный заголовок"
}
```

**Response:** `200 OK` — аналогично `create-for-activity`.

---

### POST /segments/packs/:id/supersede

Пометка KnowledgePack как SUPERSEDED (замещённый новым).

**Request Body:**
```json
{
  "supersededById": "uuid нового пакета (опционально)"
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "data": {
    "packId": "uuid",
    "status": "SUPERSEDED",
    "supersededById": "uuid"
  }
}
```

---

## Pending Approval API

API для управления pending approvals — черновыми сущностями, ожидающими подтверждения.

### GET /pending-approval

Список pending approvals с фильтрами.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `batchId` | uuid | Фильтр по batch |
| `status` | PendingApprovalStatus | Фильтр: `PENDING`, `APPROVED`, `REJECTED` |
| `limit` | number | Максимум записей (default: 50, max: 100) |
| `offset` | number | Смещение (default: 0) |

**Response:** `200 OK`
```json
{
  "items": [
    {
      "id": "uuid",
      "batchId": "uuid",
      "itemType": "activity",
      "targetId": "uuid",
      "status": "PENDING",
      "confidence": 0.85,
      "sourceQuote": "Нужно сделать макеты к пятнице",
      "sourceInteractionId": "uuid",
      "sourceEntityId": "uuid",
      "createdAt": "2026-02-01T10:00:00Z"
    }
  ],
  "total": 15,
  "limit": 50,
  "offset": 0
}
```

---

### GET /pending-approval/:id

Получение одного pending approval по ID.

**Response:** `200 OK` — объект pending approval.

| Status | Описание |
|--------|----------|
| 200 | Найден |
| 404 | Не найден |

---

### GET /pending-approval/:id/target

Получение целевой сущности (Activity/Commitment) привязанной к pending approval.

**Response:** `200 OK`
```json
{
  "itemType": "activity",
  "target": {
    "id": "uuid",
    "name": "Макеты для Alpha",
    "activityType": "TASK",
    "status": "DRAFT",
    "description": "..."
  }
}
```

| Status | Описание |
|--------|----------|
| 200 | Цель найдена |
| 404 | Approval или его цель не найдены |

---

### PATCH /pending-approval/:id/target

Обновление целевой сущности pending approval. Позволяет редактировать черновик до подтверждения.

**Request Body:**
```json
{
  "name": "Новое название",
  "description": "Новое описание",
  "priority": "HIGH",
  "deadline": "2026-03-01T00:00:00Z",
  "clientEntityId": "uuid или null",
  "assignee": "Иван",
  "dueDate": "2026-03-01T00:00:00Z"
}
```

Все поля опциональны. `deadline` и `dueDate` принимают `null` для сброса.

**Response:** `200 OK`
```json
{
  "success": true,
  "id": "uuid"
}
```

---

### POST /pending-approval/:id/approve

Подтверждение одного pending approval. Черновая сущность переводится в рабочий статус.

**Response:** `200 OK`
```json
{
  "success": true,
  "id": "uuid"
}
```

---

### POST /pending-approval/:id/reject

Отклонение одного pending approval. Черновая сущность удаляется или помечается как отклонённая.

**Response:** `200 OK`
```json
{
  "success": true,
  "id": "uuid"
}
```

---

### GET /pending-approval/batch/:batchId/stats

Статистика по batch (группе) pending approvals.

**Response:** `200 OK`
```json
{
  "batchId": "uuid",
  "total": 10,
  "pending": 5,
  "approved": 3,
  "rejected": 2
}
```

---

### POST /pending-approval/batch/:batchId/approve

Подтверждение всех PENDING элементов в batch.

**Response:** `200 OK`
```json
{
  "processed": 5,
  "errors": [],
  "batchId": "uuid"
}
```

---

### POST /pending-approval/batch/:batchId/reject

Отклонение всех PENDING элементов в batch.

**Response:** `200 OK`
```json
{
  "processed": 5,
  "errors": [],
  "batchId": "uuid"
}
```

---

## Extraction API

API для извлечения структурированных данных из текста: факты, проекты, задачи, обязательства, отношения.

### POST /extraction/facts

Извлечение фактов из одного сообщения.

**Request Body:**
```json
{
  "entityId": "uuid",
  "entityName": "Иван Петров",
  "messageContent": "Текст сообщения для анализа",
  "messageId": "uuid",
  "interactionId": "uuid"
}
```

**Response:** `200 OK` — массив извлечённых фактов с confidence.

---

### POST /extraction/facts/agent

Извлечение фактов в agent-режиме с MCP tools для cross-entity routing. Создаёт факты для упомянутых сущностей, отношения между ними, pending entities для неизвестных людей.

**Request Body:**
```json
{
  "entityId": "uuid",
  "entityName": "Иван Петров",
  "messageContent": "Текст сообщения",
  "messageId": "uuid",
  "interactionId": "uuid",
  "context": {
    "isOutgoing": false,
    "chatType": "private",
    "senderName": "Иван"
  }
}
```

**Response:** `200 OK` — результат извлечения с фактами, отношениями и pending entities.

---

### GET /extraction/entity/:entityId/facts

Извлечение фактов из истории сообщений и заметок сущности.

**Response:** `200 OK`
```json
{
  "entityId": "uuid",
  "entityName": "Иван Петров",
  "facts": [...],
  "messageCount": 25,
  "hasNotes": true,
  "tokensUsed": 1200
}
```

| Status | Описание |
|--------|----------|
| 200 | Извлечение выполнено |
| 404 | Entity не найден |

---

### POST /extraction/relations/infer

Вывод отношений из существующих фактов. Создаёт employment relations по фактам о компаниях.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `dryRun` | string | `"true"` — только отчёт без создания |
| `sinceDate` | string | ISO 8601, обрабатывать только факты после этой даты |
| `limit` | number | Максимум фактов для обработки |

**Response:** `200 OK`
```json
{
  "processed": 15,
  "created": 3,
  "skipped": 12,
  "details": [...]
}
```

---

### GET /extraction/relations/infer/stats

Статистика по потенциальным кандидатам для inference.

**Response:** `200 OK` — объект статистики.

---

### POST /extraction/daily/extract-and-save

Извлечение структурированных данных из daily synthesis и создание черновых сущностей с PendingApproval.

Заменяет старый Redis carousel flow:
- Старый: extract() → Redis carousel → persist()
- Новый: extractAndSave() → DRAFT entities + PendingApproval в БД

**Request Body:**
```json
{
  "synthesisText": "Сегодня работал над Хабом для Панавто с Машей...",
  "ownerEntityId": "uuid",
  "date": "2026-02-01",
  "focusTopic": "Панавто",
  "messageRef": "telegram:chat:123:msg:456",
  "sourceInteractionId": "uuid"
}
```

**Response:** `200 OK`
```json
{
  "batchId": "uuid",
  "counts": {
    "projects": 2,
    "tasks": 5,
    "commitments": 1,
    "relations": 3
  },
  "approvals": [
    {
      "id": "uuid",
      "itemType": "activity",
      "targetId": "uuid",
      "confidence": 0.9,
      "sourceQuote": "Макеты к пятнице"
    }
  ],
  "extraction": {
    "projectsExtracted": 2,
    "tasksExtracted": 5,
    "commitmentsExtracted": 1,
    "relationsInferred": 3,
    "summary": "Извлечено 2 проекта, 5 задач...",
    "tokensUsed": 3500,
    "durationMs": 5200
  }
}
```

| Status | Описание |
|--------|----------|
| 200 | Извлечение выполнено |
| 400 | Невалидные данные (synthesisText < 10 символов, нет ownerEntityId) |

---

### POST /extraction/reprocess-pending

Отклонение всех PENDING approvals и повторная постановка в очередь извлечения для их source interactions. Используется после обновления логики извлечения.

**Response:** `200 OK`
```json
{
  "pendingRejected": 15,
  "batchesRejected": 3,
  "interactionsQueued": 10,
  "skippedNoInteraction": 2,
  "errors": ["Interaction uuid: no messages found"]
}
```

---

## Extracted Events API

API для управления событиями, извлечёнными из переписки (встречи, задачи, обещания, факты).

### GET /extracted-events

Список извлечённых событий с фильтрами.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `status` | ExtractedEventStatus | `pending`, `confirmed`, `rejected` |
| `type` | ExtractedEventType | `task`, `meeting`, `promise_by_me`, `promise_by_them`, `fact` |
| `limit` | number | Максимум записей (default: 20) |
| `offset` | number | Смещение (default: 0) |

**Response:** `200 OK`
```json
{
  "items": [...],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

---

### GET /extracted-events/:id

Получение одного извлечённого события с привязанным сообщением.

**Response:** `200 OK` — объект ExtractedEvent с `sourceMessage` relation.

---

### POST /extracted-events/:id/confirm

Подтверждение события и создание соответствующего EntityEvent.

**Response:** `200 OK`
```json
{
  "success": true,
  "createdEntityId": "uuid созданного EntityEvent"
}
```

---

### POST /extracted-events/:id/reject

Отклонение извлечённого события.

**Response:** `200 OK`
```json
{
  "success": true
}
```

---

### POST /extracted-events/:id/remind

Создание напоминания через 7 дней для извлечённого события.

**Response:** `200 OK`
```json
{
  "success": true,
  "createdEntityId": "uuid созданного EntityEvent",
  "reminderDate": "2026-02-08T10:00:00Z"
}
```

---

### POST /extracted-events/:id/reschedule

Перенос даты события на указанное количество дней.

**Request Body:**
```json
{
  "days": 7
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "newDate": "2026-02-08T10:00:00Z",
  "updatedEntityEventId": "uuid"
}
```

| Status | Описание |
|--------|----------|
| 200 | Событие перенесено |
| 400 | `days` должен быть от 1 до 365 |
| 404 | Событие не найдено |

---

### POST /extracted-events/enrich-batch

Постановка группы событий в очередь на контекстное обогащение через LLM.

**Request Body:**
```json
{
  "limit": 50,
  "eventType": "task"
}
```

**Response:** `200 OK`
```json
{
  "queued": 25,
  "eventIds": ["uuid1", "uuid2"],
  "message": "Queued 25 events for enrichment. Check /queue/stats for progress."
}
```

---

### POST /extracted-events/:id/enrich

Ручной запуск контекстного обогащения одного события.

**Response:** `200 OK`
```json
{
  "success": true,
  "needsContext": false,
  "linkedEventId": "uuid",
  "enrichmentData": { ... }
}
```

---

### GET /extracted-events/queue/stats

Статистика очереди обогащения.

**Response:** `200 OK`
```json
{
  "waiting": 10,
  "active": 2,
  "completed": 150,
  "failed": 3
}
```

---

### POST /extracted-events/auto-cleanup

Автоматическая очистка: дедупликация событий, привязка к Activity, дедупликация Activity.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `phases` | string | Фазы через запятую: `dedup`, `match`, `activities` (default: все) |
| `dryRun` | string | `"true"` — только отчёт без изменений |

**Response:** `200 OK` — результат выполнения каждой фазы.

---

## Agent API (дополнения)

Дополнительные endpoints к Agent API, не описанные ранее.

### POST /agent/act

Выполнение действия по инструкции на естественном языке (отправка сообщений, создание напоминаний). Поддерживает approval flow для отправки сообщений через Telegram.

**Request Body:**
```json
{
  "instruction": "Напиши Сергею что встреча переносится на среду",
  "maxTurns": 10
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "data": {
    "result": "Создан черновик сообщения для Сергея и отправлен на подтверждение.",
    "actions": [
      {
        "type": "draft_created",
        "entityId": "uuid",
        "entityName": "Сергей Иванов",
        "details": "Черновик: Серёж, привет! Встреча переносится на среду."
      }
    ],
    "toolsUsed": ["list_entities", "get_entity_context", "draft_message"]
  }
}
```

| Status | Описание |
|--------|----------|
| 200 | Действие выполнено |
| 400 | Инструкция < 5 символов |
| 500 | Ошибка выполнения |

---

### POST /agent/daily/extract

Извлечение структурированных данных (проекты, задачи, обязательства) из текста ежедневного синтеза.

**Request Body:**
```json
{
  "synthesisText": "Сегодня работал над Хабом для Панавто с Машей...",
  "date": "2026-02-01",
  "focusTopic": "Панавто"
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "data": {
    "projects": [...],
    "tasks": [...],
    "commitments": [...],
    "inferredRelations": [...],
    "extractionSummary": "Извлечено 2 проекта, 3 задачи...",
    "tokensUsed": 2500,
    "durationMs": 4200
  }
}
```

---

## Mini-App API

API для Telegram Mini App. Все endpoints защищены `TelegramAuthGuard` и требуют `initData` от Telegram WebApp.

### GET /mini-app/me

Информация о текущем пользователе Telegram Mini App.

**Response:** `200 OK`
```json
{
  "user": {
    "id": 123456789,
    "firstName": "Иван",
    "lastName": "Петров",
    "username": "ivan_petrov"
  },
  "isOwner": true
}
```

---

### GET /mini-app/dashboard

Данные дашборда: pending actions, today's brief, recent activity.

**Response:** `200 OK`
```json
{
  "pendingActions": [
    {
      "type": "approval",
      "id": "all",
      "count": 15
    }
  ],
  "todayBrief": null,
  "recentActivity": []
}
```

---

### GET /mini-app/entities

Список сущностей для выбора (контакты).

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `search` | string | Поиск по имени |
| `limit` | number | Максимум записей (default: 50, max: 100) |

**Response:** `200 OK`
```json
{
  "items": [
    { "id": "uuid", "name": "Иван Петров", "type": "PERSON" }
  ]
}
```

---

### GET /mini-app/entity/:id

Профиль сущности с фактами и идентификаторами.

**Response:** `200 OK`
```json
{
  "id": "uuid",
  "type": "PERSON",
  "name": "Иван Петров",
  "avatarUrl": "https://...",
  "facts": [
    { "type": "position", "value": "CTO", "updatedAt": "2026-01-15T00:00:00Z" }
  ],
  "recentInteractions": [],
  "identifiers": [
    { "type": "telegram_user_id", "value": "123456789" }
  ]
}
```

---

### GET /mini-app/recall/:sessionId

Результаты recall сессии для отображения в Mini App. Проверяет права доступа пользователя (IDOR prevention).

**Response:** `200 OK`
```json
{
  "id": "rs_abc123",
  "query": "Что обсуждали с Иваном?",
  "answer": "Вы обсуждали...",
  "sources": [
    { "id": "uuid", "type": "message", "preview": "цитата" }
  ],
  "createdAt": "2026-02-01T10:00:00Z"
}
```

---

### GET /mini-app/brief/:id

Детали брифа. _Функциональность в разработке._

---

### POST /mini-app/brief/:id/item/:idx/action

Действие над элементом брифа (done, remind, write, prepare).

**Request Body:**
```json
{
  "action": "done"
}
```

---

### GET /mini-app/pending-approval

Список pending approvals для Mini App.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `batchId` | uuid | Фильтр по batch (`"all"` = без фильтра) |
| `status` | PendingApprovalStatus | Фильтр по статусу |
| `limit` | number | Максимум записей (default: 50, max: 100) |
| `offset` | number | Смещение |

**Response:** `200 OK` — список с маппированными полями для UI.

---

### GET /mini-app/pending-approval/stats

Глобальная статистика pending approvals.

**Response:** `200 OK` — объект статистики.

---

### GET /mini-app/pending-approval/batch/:batchId/stats

Статистика по batch для Mini App.

**Response:** `200 OK`
```json
{
  "batchId": "uuid",
  "total": 10,
  "pending": 5,
  "approved": 3,
  "rejected": 2
}
```

---

### POST /mini-app/pending-approval/batch/:batchId/approve

Подтверждение всех PENDING элементов в batch через Mini App.

**Response:** `200 OK`
```json
{
  "approved": 5,
  "errors": []
}
```

---

### POST /mini-app/pending-approval/batch/:batchId/reject

Отклонение всех PENDING элементов в batch через Mini App.

**Response:** `200 OK`
```json
{
  "rejected": 5,
  "errors": []
}
```

---

### GET /mini-app/pending-approval/:id

Один pending approval для Mini App.

**Response:** `200 OK` — маппированный объект approval.

---

### PATCH /mini-app/pending-approval/:id

Обновление целевой сущности через Mini App.

**Request Body:**
```json
{
  "name": "Новое название",
  "description": "Описание",
  "priority": "HIGH",
  "deadline": "2026-03-01T00:00:00Z",
  "parentId": "uuid"
}
```

**Response:** `200 OK` — обновлённый объект approval.

---

### POST /mini-app/pending-approval/:id/approve

Подтверждение одного элемента через Mini App.

**Response:** `200 OK`
```json
{ "success": true }
```

---

### POST /mini-app/pending-approval/:id/reject

Отклонение одного элемента через Mini App.

**Response:** `200 OK`
```json
{ "success": true }
```

---

## Entity Relations API

API для управления отношениями между сущностями (employment, friendship и т.д.).

### GET /relations/:id

Получение отношения по ID.

**Response:** `200 OK` — объект relation с members.

| Status | Описание |
|--------|----------|
| 200 | Отношение найдено |
| 404 | Не найдено |

---

### GET /relations

Получение всех отношений сущности.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `entityId` | uuid | **Обязательный.** ID сущности |
| `type` | RelationType | Фильтр по типу (`employment`, `friendship`, `family`, `business`) |

**Response:** `200 OK` — массив отношений с контекстом.

---

### POST /relations

Создание нового отношения.

**Request Body:** CreateRelationDto.

**Response:** `201 Created` — созданное отношение.

---

### DELETE /relations/:id

Soft-delete отношения (invalidation всех members).

**Response:** `200 OK`
```json
{
  "relationId": "uuid",
  "membersRemoved": 2
}
```

---

## Merge Suggestions API

API для обнаружения и выполнения merge-предложений дублирующихся сущностей.

### GET /entities/merge-suggestions

Список групп merge-предложений для orphaned entities.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `limit` | number | Максимум записей (default: 50, max: 100) |
| `offset` | number | Смещение |

**Response:** `200 OK` — группы предложений.

---

### POST /entities/merge-suggestions/:primaryId/dismiss/:candidateId

Отклонение конкретного merge-предложения.

**Response:** `204 No Content`

---

### GET /entities/merge-suggestions/preview/:sourceId/:targetId

Детальный preview merge с потенциальными конфликтами.

**Response:** `200 OK` — объект preview с конфликтами полей.

---

### POST /entities/merge-suggestions/merge

Выполнение merge с выбранными полями.

**Request Body:** MergeRequestDto.

**Response:** `200 OK` — результат merge.

---

## Entity Events API

API для управления событиями сущностей (встречи, дедлайны, обязательства, follow-up).

### POST /entity-events

Создание события.

**Request Body:**
```json
{
  "entity_id": "uuid",
  "related_entity_id": "uuid",
  "event_type": "MEETING",
  "title": "Встреча с клиентом",
  "description": "Обсуждение требований",
  "event_date": "2026-02-15T14:00:00Z",
  "status": "PENDING",
  "confidence": 0.9,
  "source_message_id": "uuid",
  "source_quote": "Давай встретимся в пятницу"
}
```

**Response:** `201 Created` — созданное событие.

---

### GET /entity-events

Список событий с фильтрами.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `entity_id` | uuid | Фильтр по сущности |
| `event_type` | EventType | `MEETING`, `DEADLINE`, `COMMITMENT`, `FOLLOW_UP`, `BIRTHDAY`, `ANNIVERSARY` |
| `status` | EventStatus | `PENDING`, `COMPLETED`, `CANCELLED`, `OVERDUE` |
| `from_date` | string | Начало периода (ISO 8601) |
| `to_date` | string | Конец периода (ISO 8601) |
| `limit` | number | Максимум записей |
| `offset` | number | Смещение |

**Response:** `200 OK` — массив событий.

---

### GET /entity-events/stats

Статистика событий.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `entity_id` | uuid | Фильтр по сущности (опционально) |

**Response:** `200 OK` — объект статистики.

---

### GET /entity-events/upcoming

Предстоящие события.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `entity_id` | uuid | Фильтр по сущности |
| `limit` | number | Максимум записей (default: 10) |

**Response:** `200 OK` — массив предстоящих событий.

---

### GET /entity-events/overdue

Просроченные события.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `entity_id` | uuid | Фильтр по сущности |
| `limit` | number | Максимум записей (default: 10) |

**Response:** `200 OK` — массив просроченных событий.

---

### GET /entity-events/:id

Получение события по ID.

**Response:** `200 OK` — объект события.

---

### PATCH /entity-events/:id

Обновление события.

**Request Body:**
```json
{
  "title": "Обновлённый заголовок",
  "description": "Обновлённое описание",
  "event_date": "2026-02-20T14:00:00Z",
  "status": "COMPLETED"
}
```

**Response:** `200 OK` — обновлённое событие.

---

### POST /entity-events/:id/complete

Пометка события как выполненного.

**Response:** `200 OK` — обновлённое событие.

---

### POST /entity-events/:id/cancel

Отмена события.

**Response:** `200 OK` — обновлённое событие.

---

### DELETE /entity-events/:id

Удаление события.

**Response:** `200 OK`
```json
{ "deleted": true }
```

---

## Notification API

API для управления уведомлениями: триггеры дайджестов, approval flow для сообщений, morning brief.

### POST /notifications/trigger/high-priority

Ручной запуск обработки высокоприоритетных событий.

**Response:** `200 OK`
```json
{ "success": true, "message": "High-priority events processed" }
```

---

### POST /notifications/trigger/hourly-digest

Ручной запуск часового дайджеста.

**Response:** `200 OK`
```json
{ "success": true, "message": "Hourly digest sent" }
```

---

### POST /notifications/trigger/daily-digest

Ручной запуск ежедневного дайджеста.

**Response:** `200 OK`
```json
{ "success": true, "message": "Daily digest sent" }
```

---

### POST /notifications/trigger/morning-brief

Ручной запуск утреннего брифа.

**Response:** `200 OK`
```json
{ "success": true, "message": "Morning brief sent" }
```

---

### GET /notifications/trigger/debug-pending

Debug: получение pending событий для дайджеста.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `priority` | string | `high`, `medium`, `low` (default: `medium`) |
| `limit` | number | Максимум записей (default: 10) |

**Response:** `200 OK`
```json
{
  "count": 5,
  "events": [
    {
      "id": "uuid",
      "eventType": "task",
      "confidence": 0.9,
      "status": "pending",
      "notificationSentAt": null,
      "extractedData": { ... }
    }
  ]
}
```

---

### POST /notifications/trigger/event/:eventId

Отправка уведомления для конкретного события (для тестирования).

**Response:** `200 OK`
```json
{ "success": true, "message": "Notification sent for event uuid" }
```

---

## Approval Flow API

API для approval flow отправки сообщений. Используется telegram-adapter для обработки нажатий кнопок.

### GET /approvals/:approvalId

Получение pending approval для отправки сообщения.

**Response:** `200 OK`
```json
{
  "success": true,
  "approval": {
    "id": "a_abc123",
    "entityId": "uuid",
    "entityName": "Иван Петров",
    "text": "Привет, Иван! Встреча переносится на среду.",
    "status": "pending",
    "editMode": null
  }
}
```

---

### POST /approvals/:approvalId/approve

Подтверждение и отправка сообщения через Telegram userbot.

**Response:** `200 OK`
```json
{
  "success": true,
  "sendResult": {
    "success": true,
    "messageId": 12345
  }
}
```

---

### POST /approvals/:approvalId/reject

Отклонение (отмена) отправки сообщения.

**Response:** `200 OK`
```json
{
  "success": true,
  "approval": {
    "id": "a_abc123",
    "status": "rejected"
  }
}
```

---

### POST /approvals/:approvalId/edit

Вход в режим редактирования сообщения.

**Response:** `200 OK`
```json
{
  "success": true,
  "approval": {
    "id": "a_abc123",
    "status": "editing",
    "text": "Текущий текст сообщения",
    "entityName": "Иван Петров"
  }
}
```

---

### POST /approvals/:approvalId/edit-mode

Установка режима редактирования: `describe` (описание для AI) или `verbatim` (прямой текст).

**Request Body:**
```json
{
  "mode": "describe"
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "approval": {
    "id": "a_abc123",
    "status": "editing",
    "editMode": "describe"
  }
}
```

---

### POST /approvals/:approvalId/update-text

Обновление текста сообщения (после verbatim edit).

**Request Body:**
```json
{
  "text": "Новый текст сообщения (1-4096 символов)"
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "approval": {
    "id": "a_abc123",
    "status": "editing",
    "text": "Новый текст сообщения"
  }
}
```

---

### POST /approvals/:approvalId/regenerate

Перегенерация сообщения через AI по описанию.

**Request Body:**
```json
{
  "description": "Перенеси встречу на четверг и извинись за неудобства (5-1000 символов)"
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "approval": {
    "id": "a_abc123",
    "status": "editing",
    "text": "Серёж, привет! Извини, встреча переносится на четверг. Сорри за неудобства!"
  }
}
```

---

## Brief API

API для управления Morning Brief (утренний бриф с accordion UI).

### GET /brief/:briefId

Получение состояния брифа.

**Response:** `200 OK`
```json
{
  "success": true,
  "state": {
    "items": [...],
    "expandedIndex": null,
    "stats": { "total": 5, "done": 2, "dismissed": 0 }
  }
}
```

---

### POST /brief/:briefId/expand/:index

Раскрытие элемента брифа для показа деталей и action buttons.

**Response:** `200 OK` — обновлённое состояние с `expandedIndex`.

---

### POST /brief/:briefId/collapse

Сворачивание всех элементов (возврат к обзору).

**Response:** `200 OK` — обновлённое состояние.

---

### POST /brief/:briefId/done/:index

Пометка элемента как выполненного.

**Response:** `200 OK`
```json
{
  "success": true,
  "state": { ... },
  "message": "Все задачи выполнены! Отличная работа!"
}
```

---

### POST /brief/:briefId/dismiss/:index

Пометка элемента как отклонённого (не актуально).

**Response:** `200 OK`
```json
{
  "success": true,
  "state": { ... },
  "message": "Все задачи обработаны!"
}
```

---

### POST /brief/:briefId/action/:index

Выполнение действия для элемента брифа (write, remind, prepare).

**Request Body:**
```json
{
  "actionType": "write"
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "message": "Action write triggered for Иван Петров",
  "state": { ... }
}
```

---

## Digest Actions API

API для разрешения коротких ID дайджеста в event UUID.

### GET /digest-actions/:shortId

Получение event IDs по короткому идентификатору из дайджеста.

**Response:** `200 OK`
```json
{
  "eventIds": ["uuid1", "uuid2", "uuid3"]
}
```

| Status | Описание |
|--------|----------|
| 200 | Short ID найден |
| 404 | Short ID не найден или истёк |

---

## Claude Agent Stats API

API для статистики использования Claude Agent.

### GET /claude-agent/stats

Статистика использования Claude Agent за период.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `period` | string | `day`, `week`, `month` (default: `month`) |

**Response:** `200 OK` — объект статистики (вызовы, токены, стоимость).

---

### GET /claude-agent/daily

Ежедневная статистика Claude Agent.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `days` | number | Количество дней (default: 30) |

**Response:** `200 OK` — массив ежедневных метрик.

---

## Summarization API

API для управления суммаризацией взаимодействий и агрегацией профилей.

### GET /summarization/stats

Агрегированные метрики суммаризации.

**Response:** `200 OK`
```json
{
  "totalInteractions": 500,
  "summarizedInteractions": 350,
  "summarizationCoverage": 70.0,
  "pendingInQueue": 5,
  "oldestUnsummarized": "2026-01-15T00:00:00Z",
  "avgCompressionRatio": 0.15,
  "avgKeyPointsPerSummary": 4.2,
  "avgDecisionsPerSummary": 1.5,
  "totalOpenActionItems": 23
}
```

---

### GET /summarization/queue

Статус очередей суммаризации и агрегации профилей.

**Response:** `200 OK`
```json
{
  "summarization": {
    "waiting": 5,
    "active": 2,
    "completed": 300,
    "failed": 3,
    "delayed": 0
  },
  "entityProfile": {
    "waiting": 0,
    "active": 1,
    "completed": 50,
    "failed": 0,
    "delayed": 0
  }
}
```

---

### POST /summarization/trigger/:interactionId

Запуск суммаризации для конкретного взаимодействия.

**Response:** `200 OK`
```json
{
  "success": true,
  "summaryId": "uuid",
  "message": "Summary created successfully"
}
```

---

### POST /summarization/trigger-batch

Пакетный запуск суммаризации для нескольких взаимодействий.

**Request Body:**
```json
{
  "interactionIds": ["uuid1", "uuid2", "uuid3"]
}
```

**Response:** `200 OK`
```json
{
  "triggered": 2,
  "skipped": 1,
  "results": [
    { "id": "uuid1", "status": "created" },
    { "id": "uuid2", "status": "already_exists" },
    { "id": "uuid3", "status": "skipped" }
  ]
}
```

---

### GET /summarization/status/:interactionId

Статус суммаризации взаимодействия.

**Response:** `200 OK`
```json
{
  "interactionId": "uuid",
  "hasSummary": true,
  "summary": {
    "id": "uuid",
    "summaryText": "...",
    "keyPoints": ["point1", "point2"],
    "tone": "formal",
    "messageCount": 45,
    "compressionRatio": 0.12,
    "createdAt": "2026-02-01T00:00:00Z"
  }
}
```

---

### GET /summarization/interaction/:interactionId

Получение summary по interaction ID.

**Response:** `200 OK` — полный объект InteractionSummary.

| Status | Описание |
|--------|----------|
| 200 | Summary найден |
| 404 | Summary не найден |

---

### POST /summarization/trigger-daily

Ручной запуск ежедневной задачи суммаризации.

**Response:** `200 OK`
```json
{ "message": "Daily summarization job triggered" }
```

---

### POST /summarization/profile/trigger/:entityId

Запуск агрегации профиля для конкретной сущности.

**Response:** `200 OK`
```json
{
  "success": true,
  "profileId": "uuid",
  "message": "Profile created/updated successfully"
}
```

| Status | Описание |
|--------|----------|
| 200 | Профиль создан/обновлён |
| 400 | Ошибка агрегации |
| 404 | Entity не найден |

---

### GET /summarization/profile/entity/:entityId

Получение профиля по entity ID.

**Response:** `200 OK` — объект EntityRelationshipProfile.

---

### GET /summarization/profile/status/:entityId

Статус профиля сущности.

**Response:** `200 OK`
```json
{
  "entityId": "uuid",
  "hasProfile": true,
  "summariesCount": 15,
  "profile": {
    "id": "uuid",
    "relationshipType": "colleague",
    "relationshipSummary": "Коллега по проекту...",
    "totalInteractions": 30,
    "updatedAt": "2026-02-01T00:00:00Z"
  }
}
```

---

### POST /summarization/profile/trigger-weekly

Ручной запуск еженедельной агрегации профилей.

**Response:** `200 OK`
```json
{ "message": "Weekly profile aggregation job triggered" }
```

---

## Group Memberships API

API для отслеживания участников групповых чатов.

### POST /group-memberships/change

Регистрация изменения участия в группе.

**Request Body:**
```json
{
  "telegram_chat_id": "-1001234567890",
  "telegram_user_id": "123456789",
  "display_name": "Иван Петров",
  "action": "joined",
  "timestamp": "2026-02-01T10:00:00Z"
}
```

**Response:** `200 OK` — результат обработки.

---

### GET /group-memberships/chat/:telegramChatId

Список активных участников чата.

**Response:** `200 OK`
```json
{
  "telegramChatId": "-1001234567890",
  "activeCount": 5,
  "members": [...]
}
```

---

### GET /group-memberships/user/:telegramUserId

Группы, в которых состоит пользователь.

**Response:** `200 OK`
```json
{
  "telegramUserId": "123456789",
  "groupsCount": 3,
  "groups": [...]
}
```

---

### GET /group-memberships/history

История участия в группе.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `telegramChatId` | string | ID чата |
| `telegramUserId` | string | ID пользователя |

**Response:** `200 OK`
```json
{
  "telegramChatId": "-1001234567890",
  "telegramUserId": "123456789",
  "history": [...]
}
```

---

### GET /group-memberships/stats

Общая статистика по group memberships.

**Response:** `200 OK` — объект статистики.

---

## Pending Facts API

API для управления фактами, ожидающими подтверждения.

### GET /pending-facts

Список pending facts с фильтрами.

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `status` | PendingFactStatus | Фильтр по статусу |
| `limit` | number | Максимум записей |
| `offset` | number | Смещение |

**Response:** `200 OK` — массив pending facts.

---

### GET /pending-facts/:id

Получение одного pending fact.

**Response:** `200 OK` — объект pending fact.

---

### PATCH /pending-facts/:id/approve

Подтверждение pending fact (создание entity fact).

**Response:** `200 OK` — результат подтверждения.

---

### PATCH /pending-facts/:id/reject

Отклонение pending fact.

**Response:** `200 OK` — результат отклонения.

---

## Activity Enrichment API

API для AI-обогащения описаний Activity.

### POST /activities/enrich-descriptions

Находит Activity без описания и генерирует описания через Claude AI из доступного контекста (name, type, parent, client, tags, metadata.sourceQuote). Обработка идёт батчами по 20.

**Response:** `200 OK`
```json
{
  "enriched": 15,
  "total": 20,
  "errors": 2,
  "errorDetails": [
    { "id": "uuid", "name": "Task name", "error": "Claude timeout" }
  ]
}
```

---

## Коды ошибок

| HTTP Code | Описание |
|-----------|----------|
| 400 | Bad Request — невалидные данные |
| 401 | Unauthorized — неверный API Key |
| 404 | Not Found — ресурс не найден |
| 409 | Conflict — дубликат |
| 422 | Unprocessable Entity — семантическая ошибка |
| 500 | Internal Server Error |
| 503 | Service Unavailable |

**Формат ошибки:**
```json
{
  "error": {
    "code": "ENTITY_NOT_FOUND",
    "message": "Entity with id 'xxx' not found",
    "details": {}
  }
}
```
