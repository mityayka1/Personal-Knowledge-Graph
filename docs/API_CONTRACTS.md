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
