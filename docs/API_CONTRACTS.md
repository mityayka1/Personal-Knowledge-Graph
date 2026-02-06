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
