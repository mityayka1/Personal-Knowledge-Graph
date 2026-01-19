Cj# PKG Second Brain — Implementation Checklist

> Краткий чеклист для отслеживания прогресса. Детали в [ROADMAP_SECOND_BRAIN.md](./ROADMAP_SECOND_BRAIN.md)
Jl;ПР
## Pre-requisites

- [x] Верификация миграции Agent SDK
  - [x] Директория `claude-cli/` удалена
  - [x] Нет импортов ClaudeCliService
  - [x] Все тесты проходят
  - [x] Приложение запускается

---

## Phase B: Recall & Prepare (Week 1-2)

### Week 1: API

#### B1.1 Верификация (Day 1)
- [x] Проверить отсутствие claude-cli
- [x] Grep по ClaudeCliService = 0 результатов
- [x] `pnpm test` проходит

#### B1.2 AgentController (Day 1)
- [x] Controller создан
- [x] DTOs с валидацией
- [x] Swagger документация

#### B1.3 Recall Endpoint (Day 2-3)
- [x] POST /agent/recall работает
- [x] Итеративный поиск (видно tool calls в логах)
- [x] Ответ содержит sources
- [x] Фильтрация по entityId
- [x] Timeout обработка

#### B1.4 Recall Tests (Day 3)
- [x] E2E тест: успешный поиск
- [x] E2E тест: maxTurns limit
- [x] E2E тест: пустой результат

#### B1.5 Prepare Endpoint (Day 4-5)
- [x] POST /agent/prepare/:entityId работает
- [x] Brief содержит все секции
- [ ] Context влияет на suggestedTopics

### Week 2: Telegram

#### B2.1 Telegram Handler (Day 6-7)
- [x] /recall команда
- [x] /prepare команда
- [ ] Natural language detection

#### B2.2 Bot Commands (Day 7)
- [x] Команды зарегистрированы
- [ ] Help message для agent commands

#### B2.3 E2E Testing (Day 8-10)
- [ ] Тест на реальных данных
- [ ] Performance < 30 сек
- [x] Error handling

#### B2.4 Metrics (Day 10)
- [ ] Логирование запросов
- [ ] Usage tracking

---

## Phase C: Extract & React (Week 3-5)

### Week 3: Entities

#### C1.1 ExtractedEvent Entity (Day 11-12)
- [x] Entity создана
- [x] Миграция применена
- [x] CRUD работает

#### C1.2 Миграция БД (Day 12)
- [x] Таблица extracted_events
- [x] Индексы созданы
- [x] Enum types

#### C1.3 EventExtractionService (Day 13-15)
- [x] extractFromMessage работает
- [x] Confidence scoring
- [x] Batch processing
- [x] JSON Schema для extraction

### Week 4: Notifications

#### C2.1 Message Processing Queue (Day 16-17)
- [x] BullMQ queue настроена
- [x] Event extraction в pipeline
- [x] Worker processor

#### C2.2 BullMQ Worker (Day 17)
- [x] Processor создан
- [x] Retry logic
- [x] Error handling

#### C2.3 NotificationService (Day 18-19)
- [x] notifyAboutEvent работает
- [x] Priority calculation
- [x] Digest aggregation

#### C2.4 Callback Handlers (Day 20-21)
- [x] event_confirm handler
- [x] event_reject handler
- [x] event_reschedule handler
- [x] event_remind handler

#### C2.5 API Endpoints (Day 21)
- [x] GET /extracted-events
- [x] POST /:id/confirm
- [x] POST /:id/reject
- [x] POST /:id/remind
- [x] POST /:id/reschedule

### Week 5: Scheduled Jobs

#### C3.1 Cron Jobs (Day 22-24)
- [x] High-priority processing (*/5 * * * *)
- [x] Hourly digest (0 * * * *)
- [x] Daily digest (0 21 * * *)
- [x] Morning brief (0 8 * * *)
- [x] Expire old events (0 3 * * *)

#### C3.2 DigestService (Day 24)
- [x] sendMorningBrief
- [x] sendHourlyDigest
- [x] sendDailyDigest
- [x] formatMorningBrief

---

## Phase C+: UX Improvements ✅ COMPLETED

> См. [ROADMAP_SECOND_BRAIN.md](./ROADMAP_SECOND_BRAIN.md#улучшения-phase-c-post-mvp)

#### Issue #61: Carousel UX ✅ (PR #63)
- [x] Carousel state в Redis (CarouselStateService)
- [x] editMessageText при навигации
- [x] Пропуск обработанных событий
- [x] Исправить дублирование уведомлений

#### Issue #62: Context-Aware Extraction ✅ (PR #66)
- [x] Поле `linkedEventId` в ExtractedEvent
- [x] Поле `needsContext` в ExtractedEvent
- [x] ContextEnrichmentService
- [x] Extraction prompt для абстрактных событий
- [x] Связывание событий (follow-up, reminder)
- [x] `https://t.me/username` ссылки на контакты
- [x] Deep link на исходное сообщение
- [x] UX для событий с needsContext

---

## Phase A: Act Capabilities (Week 6-7)

> См. [PLAN_PHASE_A.md](./PLAN_PHASE_A.md) для детального плана

### Week 6: Core Infrastructure ✅ COMPLETED

#### A1.1 ActionToolsProvider (Day 25-26) ✅
- [x] draft_message tool
- [x] send_telegram tool
- [x] schedule_followup tool

#### A1.2 ApprovalService (Day 27-28) ✅
- [x] createApproval method (non-blocking)
- [x] requestApproval method (blocking with Promise)
- [x] handleAction (approve/reject/edit)
- [x] setEditMode / updateText
- [x] Redis storage with TTL (2 min)
- [x] Pub/Sub for async notification

#### A1.3 Approval UI (Day 28) ✅
- [x] sendApprovalMessage with buttons
- [x] Три кнопки: ✅ Отправить / ✏️ Изменить / ❌ Отмена
- [x] Callback format: act_a:{id}, act_e:{id}, act_r:{id}

#### A1.4 Module Integration (Day 28) ✅
- [x] NotificationModule exports ApprovalService
- [x] ClaudeAgentModule imports NotificationModule (forwardRef)
- [x] ActionToolsProvider injected with forwardRef
- [x] ToolsRegistryService registers action tools

### Week 7: Integration & UX

#### A2.1 Act Endpoint (Day 29) ✅
- [x] POST /agent/act works
- [x] Tools: list_entities → draft_message → send_telegram
- [x] Response with actions array

#### A2.2 Approval GET Endpoint (Day 29) ✅
- [x] GET /api/v1/approvals/:id
- [x] Returns approval status from Redis

#### A2.3 Edit Mode Selection (Day 30)
- [ ] Кнопки: Задать / Как есть
- [ ] "Задать" → AI генерирует по описанию
- [ ] "Как есть" → отправка verbatim текста
- [ ] Callback handlers: edit_describe, edit_verbatim

#### A2.4 Proactive Action Buttons (Day 31)
- [ ] Action buttons в Morning Brief
- [ ] Кнопка [💬 Написать X] для задач
- [ ] Кнопка [💬 Напомнить X] для follow-ups
- [ ] Кнопка [📋 Подготовить brief] для встреч
- [ ] Callback format: act_write:{entityId}:{eventId}

#### A2.5 Follow-up Suggestion (Day 31)
- [ ] Предложение после успешной отправки
- [ ] Кнопки: Через 2 часа / Завтра / Не нужно
- [ ] Автоматическое создание EntityEvent (FOLLOW_UP)

#### A2.6 Send-as-User Integration (Day 32)
- [ ] POST /telegram/send-as-user в Telegram Adapter
- [ ] GramJS sendMessage через юзербот
- [ ] Логирование отправленных сообщений

#### A2.7 /act Command (Day 32)
- [ ] /act команда в боте
- [ ] Natural language action detection
- [ ] Integration tests

---

## Final Verification

### Phase B Metrics
- [ ] Recall accuracy > 80%
- [ ] Prepare time < 30 sec
- [ ] Weekly usage > 5 requests

### Phase C Metrics
- [ ] Extraction accuracy > 85%
- [ ] False positive rate < 5%
- [ ] Morning brief daily

### Phase A Metrics
- [ ] 100% approval coverage
- [ ] 0 unauthorized sends
- [ ] Request-to-send < 60 sec

---

## Documentation

- [x] API Swagger docs (available at /api/v1/docs)
- [ ] User guide
- [ ] Troubleshooting guide
- [ ] Architecture diagram update

---

## Notes

```
Start Date: ___________
Phase B Complete: ___________
Phase C Complete: ___________
Phase A Complete: ___________
```
