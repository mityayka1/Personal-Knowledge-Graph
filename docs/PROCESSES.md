# Процессы PKG

## Обзор

Документ описывает все бизнес-процессы системы PKG с детализацией шагов, участников и правил.

---

## 1. Ingestion процессы

### 1.1 Telegram Message Ingestion

**Участники:** Telegram Server → Telegram Adapter → PKG Core

**Триггер:** Новое сообщение в Telegram (входящее или исходящее)

**Шаги:**

1. **Telegram Adapter получает событие от GramJS**

2. **Извлечение данных:**
   - chat_id, user_id, username, display_name
   - message_id, text, timestamp
   - is_outgoing (true если от пользователя системы)
   - media_type, media (если есть)

3. **Session Management:**
   - Проверить `last_message_time` для chat_id
   - IF (now - last_message_time) > 4 hours:
     - Отправить POST /sessions/end для предыдущей сессии
     - Сбросить session state
   - Обновить last_message_time = now

4. **Обработка media:**
   - IF media_type == 'voice':
     - Скачать файл в /data/files/voice/{msg_id}.ogg
     - POST /voice-jobs с file_path
     - RETURN (сообщение будет создано после транскрипции)
   - IF other media:
     - Скачать файл в /data/files/media/
     - Добавить media_url в payload

5. **POST /messages в PKG Core**

6. **PKG Core обрабатывает** (см. 1.2)

**Правила Session Management:**

| Условие | Действие |
|---------|----------|
| Gap > 4 часов | Завершить текущую сессию, начать новую |
| Gap ≤ 4 часов | Продолжить текущую сессию |
| Новый chat_id | Создать новую сессию |

**Обработка ошибок:**
- PKG Core недоступен → добавить в retry queue, retry с exponential backoff
- Файл не скачался → логировать ошибку, продолжить без media
- Retry queue persisted → при рестарте adapter восстановить и продолжить

---

### 1.2 Message Processing (PKG Core)

**Триггер:** POST /messages от Adapter

**Шаги:**

1. **Валидация входных данных**

2. **Entity Resolution:**
   - Поиск в entity_identifiers по (type, value)
   - IF найден:
     - entity_id = найденный entity
     - Обновить metadata если изменились
   - IF не найден:
     - Проверить pending_entity_resolutions
     - IF есть pending: entity_id = null, добавить message_id в sample_message_ids
     - IF нет pending: создать pending_entity_resolution, entity_id = null

3. **Interaction Management:**
   - Поиск активной interaction для chat_id
   - IF найдена И (now - last_message) ≤ 4h:
     - interaction_id = найденная
   - IF найдена И (now - last_message) > 4h:
     - Завершить текущую: status = 'completed', ended_at = now
     - Создать новую interaction
   - IF не найдена:
     - Создать новую interaction
     - Добавить participants (self + other)

4. **Создание Message:**
   - INSERT в messages с interaction_id, entity_id, content, etc.

5. **Queue Embedding Job:**
   - Добавить job в BullMQ для генерации embedding
   - Job выполнится асинхронно

6. **Return Response**

---

### 1.3 Phone Call Upload & Processing

**Участники:** User → PKG Core → Worker → PKG Core

**Триггер:** Загрузка аудиофайла через UI или API

**Шаги:**

1. **User загружает файл:**
   - Аудиофайл (mp3, wav, ogg, m4a)
   - Metadata: phone_number, direction (in/out), date, duration

2. **PKG Core:**
   - Валидация файла (формат, размер)
   - Сохранение в /data/files/calls/{uuid}.{ext}
   - Создание Interaction (type=phone_call, status=processing)
   - Создание Job (type=transcription)

3. **Webhook в Worker:** job_id, interaction_id, file_path, metadata

4. **Worker (n8n workflow):**
   - ffmpeg: конвертация в wav 16kHz mono
   - Whisper: транскрипция с diarization → segments с speaker labels
   - Claude Code CLI: Speaker Mapping Agent
     - Input: Транскрипт, metadata (direction, phone)
     - Task: определить кто self/other, извлечь имя, факты, action items
     - Output JSON: speaker_mapping, other_speaker, extracted_facts, summary
   - Отправка результатов в PKG Core

5. **PKG Core получает результаты:**
   - POST /transcript-segments — создание сегментов
   - Entity Resolution для other_speaker (по phone или pending)
   - POST /extracted-facts — создание фактов
   - Update Interaction: status = 'pending_review' или 'completed'

6. **Уведомление пользователя** в Telegram

**Prompt для Speaker Mapping Agent:**

```
You are analyzing a phone call transcription.

## Input
- Transcript file: {filepath}
- Call metadata:
  - Phone number: {phone_number}
  - Direction: {direction} (incoming/outgoing)
  - Duration: {duration} seconds

## Task
1. Determine which speaker is "self":
   - If outgoing: initiator is likely "self"
   - If incoming: receiver is likely "self"
2. For other speaker(s):
   - Extract self-identification ("Это Иван", "Петров слушает")
   - Note communication style
3. Extract facts: dates, amounts, decisions, action items, contacts

## Output JSON
{
  "speaker_mapping": { "Speaker_0": "self" | "other" },
  "other_speaker": { "suggested_name": string|null, "confidence": 0.0-1.0 },
  "extracted_facts": [{ "type", "value", "raw_quote", "confidence" }],
  "summary": "2-3 sentences",
  "action_items": []
}
```

---

## 2. Entity Resolution процессы

### 2.1 Автоматический Entity Resolution

**Триггер:** Новое сообщение с неизвестным identifier

**Шаги:**

1. Поиск в entity_identifiers: SELECT WHERE identifier_type = :type AND identifier_value = :value
   - IF найден → RETURN entity_id (success)

2. Проверка pending_entity_resolutions: SELECT WHERE identifier_type = :type AND identifier_value = :value
   - IF найден: добавить message_id в sample_message_ids, RETURN null

3. Создание PendingEntityResolution:
   - INSERT (identifier_type, identifier_value, display_name, status='pending', first_seen_at=now())
   - RETURN null

---

### 2.2 Автоматические Suggestions (Worker)

**Триггер:** Schedule (ежедневно 09:00)

**Шаги:**

1. Worker получает pending resolutions: GET /pending-resolutions?status=pending&limit=10

2. Для каждого pending resolution:
   - Получить sample messages
   - Получить существующие entities для сравнения
   - Claude Code CLI: Entity Matching Agent
     - Analyze communication style
     - Look for self-identification
     - Compare with existing entities
     - Output: suggestions с confidence и reason
   - PATCH /pending-resolutions/{id}/suggestions

3. PKG Core обрабатывает suggestions:
   - IF max(confidence) > 0.9: auto-resolve, обновить messages, status = 'resolved'
   - ELSE: сохранить suggestions, отправить уведомление для manual review

---

### 2.3 Manual Entity Resolution

**Триггер:** User action в UI

**Варианты:**

**A. Связать с существующим entity:**
```
POST /pending-resolutions/{id}/resolve { "entity_id": "existing-uuid" }
→ Создать entity_identifier
→ Обновить все messages: sender_entity_id = entity_id
→ Обновить interaction_participants
→ status = 'resolved'
```

**B. Создать новый entity:**
```
POST /pending-resolutions/{id}/create-new { "name": "...", "type": "person" }
→ Создать entity + entity_identifier
→ Обновить messages и participants
→ status = 'resolved'
```

**C. Игнорировать:**
```
PATCH /pending-resolutions/{id} { "status": "ignored" }
→ Messages остаются без entity_id
```

---

## 3. Context Retrieval процессы

### 3.1 Context Synthesis

**Триггер:** POST /context

**Шаги:**

1. **Resolve Entity:**
   - IF entity_id provided → use directly
   - IF entity_name provided → fuzzy search, error if multiple/no matches

2. **Gather Data:**
   - Entity info + organization
   - Facts (current, valid_until IS NULL)
   - Recent interactions (last 30 days):
     - Полные данные для недавних (< 7 дней)
     - Summaries для старых (7-30 дней)
   - Messages/segments с highest relevance:
     - IF task_hint → vector search по task_hint
     - ELSE → последние N сообщений
   - Open items: незакрытые action_items, pending facts

3. **Webhook в Worker (Context Synthesis)**

4. **Worker: Claude Code CLI Context Synthesis Agent**
   - Synthesize structured context
   - Focus on task_hint if provided
   - Token budget: max_tokens parameter
   - Output: Markdown formatted context

5. **Return Context to Client**

**Формат выходного контекста:**

```markdown
## Контекст: {Entity Name}

**Тип:** Person/Organization
**Организация:** {если person с org}
**Роль:** {position из facts}

### Ключевые факты
- День рождения: {birthday}
- Должность: {position}
- Контакты: {phones, emails}

### Текущий статус
{Описание текущего состояния отношений}

### Открытые вопросы
- {Action item 1}
- {Вопрос без ответа}

### Последние взаимодействия
- **{дата} [{тип}]:** {описание}

### Ключевые договорённости
- {дата}: {решение}
```

---

### 3.2 Search

**Триггер:** POST /search

**Типы поиска:**

| Тип | Описание |
|-----|----------|
| `fts` | Full-text search — точное совпадение слов |
| `vector` | Semantic search — поиск по смыслу |
| `hybrid` | FTS + Vector с RRF (default) |

**Процесс Hybrid Search:**

1. Параллельно выполнить:
   - FTS Search: WHERE to_tsvector(...) @@ plainto_tsquery(...)
   - Vector Search: ORDER BY embedding <=> :query_embedding

2. Reciprocal Rank Fusion (RRF):
   - score(doc) = Σ 1/(k + rank_i(doc)), где k = 60

3. Сортировка по RRF score, LIMIT

4. Enrich results: entity info, interaction context, highlights

---

## 4. Automation процессы (Worker)

### 4.1 Interaction Summarization

**Триггер:** Schedule (weekly, Sunday 03:00)

**Шаги:**

1. Получить interactions: GET /interactions?older_than=30d&no_summary=true&limit=50

2. Для каждой interaction:
   - Получить полный контент
   - Claude Code CLI: Summarization Agent
     - Create compact summary (100-200 words)
     - Extract key_points, decisions, action items, facts
   - POST /interactions/{id}/summary

3. Опционально: Archive original messages

---

### 4.2 Fact Extraction from Messages

**Триггер:** Schedule или webhook (batch каждые 5 минут)

**Шаги:**

1. Получить новые messages с resolved entity_id

2. Группировка по entity_id

3. Для каждой группы:
   - Claude Code CLI: Fact Extraction Agent
     - Find: birthday, phones, emails, positions, dates, amounts
     - Include exact quote
   - POST /extracted-facts
     - confidence > 0.9 → EntityFact
     - confidence 0.7-0.9 → PendingFact
     - confidence < 0.7 → discard

---

### 4.3 Weekly Digest

**Триггер:** Schedule (Monday 08:00)

**Шаги:**

1. Gather Weekly Stats:
   - New entities, interactions count, messages count
   - Pending resolutions, upcoming birthdays
   - Stale conversations, top active entities

2. Claude Code CLI: Digest Generation Agent
   - Generate friendly digest in Russian
   - Format for Telegram (markdown)

3. Send to Telegram

**Пример:**

```markdown
📊 **Еженедельный дайджест PKG**
_6-12 января 2025_

**Статистика:**
• Новых контактов: 3
• Взаимодействий: 47
• Сообщений: 523

🎂 **Дни рождения:**
• 10 января — Иван Петров

⚠️ **Требует внимания:**
• 2 контакта ожидают identification
```

---

## 5. Maintenance процессы

### 5.1 Embedding Generation

**Триггер:** BullMQ job queue

**Шаги:**
1. Получить job из очереди
2. Загрузить content
3. Вызов OpenAI API: text-embedding-3-small
4. UPDATE record SET embedding = :embedding
5. Mark job completed

**Retry policy:** 3 attempts с exponential backoff

---

### 5.2 Session Cleanup

**Триггер:** Schedule (hourly)

**Шаги:**
1. Найти активные interactions где last_message > 4 hours ago
2. Обновить status = 'completed', ended_at = last_message_time
3. Опционально: trigger summarization

---

### 5.3 Pending Resolution Reminder

**Триггер:** Schedule (daily)

**Шаги:**
1. Найти pending_entity_resolutions с first_seen_at > 3 days
2. Если есть suggestions с confidence > 0.7 → отправить reminder
3. Если нет suggestions → trigger Worker для analysis
