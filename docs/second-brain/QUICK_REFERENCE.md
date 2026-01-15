# PKG Second Brain — Quick Reference

> Краткий справочник по API и командам после завершения всех фаз

## API Endpoints

### Agent Endpoints

| Method | Endpoint | Description | Phase |
|--------|----------|-------------|-------|
| POST | `/agent/recall` | Поиск информации в естественном языке | B |
| POST | `/agent/prepare/:entityId` | Meeting brief для контакта | B |
| POST | `/agent/act` | Выполнение действий с approval | A |

### Extracted Events

| Method | Endpoint | Description | Phase |
|--------|----------|-------------|-------|
| GET | `/extracted-events` | Список извлечённых событий | C |
| POST | `/extracted-events/:id/confirm` | Подтвердить событие | C |
| POST | `/extracted-events/:id/reject` | Отклонить событие | C |

---

## Telegram Commands

### Phase B

```
/recall <вопрос>
  Поиск информации в истории сообщений
  Пример: /recall кто советовал юриста по IP?

/prepare <имя контакта>
  Подготовка brief к встрече
  Пример: /prepare Петр Иванов
```

### Phase A

```
/act <инструкция>
  Выполнить действие (с подтверждением)
  Пример: /act напиши Сергею что встреча переносится
```

### Natural Language (auto-detected)

```
"Найди..." / "Вспомни..." / "Кто..." / "Что..."
  → Автоматически обрабатывается как /recall

"Напиши..." / "Отправь..." / "Напомни..."
  → Автоматически обрабатывается как /act
```

---

## Scheduled Jobs

| Cron | Time (Moscow) | Job | Phase |
|------|---------------|-----|-------|
| `*/5 * * * *` | Every 5 min | High-priority event notifications | C |
| `0 * * * *` | Every hour | Hourly digest | C |
| `0 8 * * *` | 08:00 | Morning brief | C |
| `0 21 * * *` | 21:00 | Daily digest | C |
| `0 3 * * *` | 03:00 | Expire old pending events | C |

---

## Event Types

### ExtractedEvent Types

| Type | Description | Example |
|------|-------------|---------|
| `meeting` | Договорённость о встрече | "созвонимся завтра в 15:00" |
| `promise_by_me` | Моё обещание | "я пришлю завтра" |
| `promise_by_them` | Их обещание | "пришлю документ до пятницы" |
| `task` | Просьба/задача | "можешь глянуть код?" |
| `fact` | Личный факт | "у меня ДР 15 марта" |
| `cancellation` | Отмена/перенос | "давай перенесём" |

### EntityEvent Types

| Type | Description |
|------|-------------|
| `meeting` | Запланированная встреча |
| `deadline` | Дедлайн |
| `commitment` | Обещание/обязательство |
| `follow_up` | Напоминание проверить |

---

## Tool Categories

```typescript
// Использование в агентах
const tools = toolsRegistry.getToolsByCategory(['search', 'entities']);

// Доступные категории:
'search'   // search_messages
'entities' // list_entities, get_entity_details
'events'   // create_reminder, get_upcoming_events
'context'  // get_entity_context
'actions'  // draft_message, send_telegram, schedule_followup (Phase A)
'all'      // Все tools
```

---

## Notification Priority

| Priority | Trigger | Notification |
|----------|---------|--------------|
| **High** | Meeting < 24h, Cancellation, Confidence > 0.9 | Немедленно |
| **Medium** | Promise с deadline, Task | Hourly digest |
| **Low** | Fact, Promise без deadline | Daily digest |

---

## Approval Flow (Phase A)

```
User: "напиши Сергею что встреча переносится"
  ↓
Agent: find_entity("Сергей") → entityId
  ↓
Agent: draft_message(entityId, "перенос встречи")
  ↓
Bot: "📤 Отправить сообщение? [✅ Отправить] [❌ Отмена] [✏️ Редактировать]"
  ↓
User: clicks ✅
  ↓
Agent: send_telegram(entityId, text) → Message sent
```

---

## Configuration

### Environment Variables

```bash
# Agent SDK
CLAUDE_DEFAULT_MODEL=sonnet
CLAUDE_MAX_TURNS=15
CLAUDE_BUDGET_USD=0.50

# Notifications
NOTIFICATION_QUIET_START=22:00
NOTIFICATION_QUIET_END=09:00
NOTIFICATION_TIMEZONE=Europe/Moscow

# Extraction
EXTRACTION_MIN_CONFIDENCE=0.5
EXTRACTION_BATCH_SIZE=10
```

### Tool Timeout

```typescript
// Default timeouts
const ONESHOT_TIMEOUT = 120000;  // 2 min
const AGENT_TIMEOUT = 300000;    // 5 min
const APPROVAL_TIMEOUT = 120000; // 2 min
```

---

## Error Handling

### Agent Errors

| Error | Cause | Resolution |
|-------|-------|------------|
| `No result from Claude` | Timeout or empty response | Retry with shorter prompt |
| `Max turns exceeded` | Query too complex | Simplify or increase maxTurns |
| `Budget exceeded` | Cost limit reached | Increase budgetUsd |

### Notification Errors

| Error | Cause | Resolution |
|-------|-------|------------|
| `Entity has no Telegram` | Missing identifier | Add Telegram ID to entity |
| `Approval timeout` | User didn't respond | Auto-reject after 2 min |

---

## Monitoring

### Key Metrics

```typescript
// Recall
- recall_requests_total
- recall_success_rate
- recall_avg_turns
- recall_avg_duration_ms

// Extraction
- events_extracted_total
- events_confirmed_rate
- events_rejected_rate
- extraction_confidence_avg

// Act
- actions_requested_total
- actions_approved_rate
- actions_timeout_rate
```

### Logs

```bash
# Agent calls
[ClaudeAgentService] Oneshot call: task=recall, model=sonnet
[ClaudeAgentService] Agent call: task=meeting_prep, turns=5, tools=[search_messages, get_entity_details]

# Event extraction
[EventExtractionService] Extracted 2 events from message abc-123
[NotificationService] Sent high-priority notification for event xyz-789

# Actions
[ApprovalHookService] Approval requested for send_telegram to entity xyz
[ApprovalHookService] Approval granted after 15s
```
