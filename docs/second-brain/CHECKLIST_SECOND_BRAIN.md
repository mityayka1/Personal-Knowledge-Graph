# PKG Second Brain — Implementation Checklist

> Краткий чеклист для отслеживания прогресса. Детали в [ROADMAP_SECOND_BRAIN.md](./ROADMAP_SECOND_BRAIN.md)

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
- [ ] Swagger документация

#### B1.3 Recall Endpoint (Day 2-3)
- [x] POST /agent/recall работает
- [x] Итеративный поиск (видно tool calls в логах)
- [x] Ответ содержит sources
- [ ] Фильтрация по entityId
- [x] Timeout обработка

#### B1.4 Recall Tests (Day 3)
- [ ] E2E тест: успешный поиск
- [ ] E2E тест: maxTurns limit
- [ ] E2E тест: пустой результат

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
- [ ] event_reschedule handler
- [ ] event_remind handler

#### C2.5 API Endpoints (Day 21)
- [x] GET /extracted-events
- [x] POST /:id/confirm
- [x] POST /:id/reject

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

## Phase C+: UX Improvements (Post-MVP)

> См. [ROADMAP_SECOND_BRAIN.md](./ROADMAP_SECOND_BRAIN.md#улучшения-phase-c-post-mvp)

#### Issue #61: Carousel UX
- [ ] Carousel state в Redis
- [ ] editMessageText при навигации
- [ ] Пропуск обработанных событий
- [ ] Исправить дублирование уведомлений

#### Issue #62: Context-Aware Extraction
- [ ] Поле `linkedEventId` в ExtractedEvent
- [ ] Поле `needsContext` в ExtractedEvent
- [ ] ContextEnrichmentService
- [ ] Extraction prompt для абстрактных событий
- [ ] Связывание событий (follow-up, reminder)
- [ ] `tg://user?id=X` ссылки
- [ ] Deep link на исходное сообщение
- [ ] UX для событий с needsContext

---

## Phase A: Act Capabilities (Week 6-7)

### Week 6: Action Tools

#### A1.1 ActionToolsProvider (Day 25-26)
- [ ] draft_message tool
- [ ] send_telegram tool
- [ ] schedule_followup tool

#### A1.2 Approval Hooks (Day 27-28)
- [ ] ApprovalHookService
- [ ] requestApproval method
- [ ] handleApprovalResponse
- [ ] Timeout handling (2 min)

#### A1.3 TelegramSendService (Day 28)
- [ ] sendToEntity method
- [ ] Identifier lookup
- [ ] Error handling

### Week 7: Integration

#### A1.4 Act Endpoint (Day 29)
- [ ] POST /agent/act
- [ ] Approval hook integration
- [ ] Response formatting

#### A1.5 Telegram Bot (Day 30)
- [ ] /act command
- [ ] Approval callbacks
- [ ] Edit message flow

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

- [ ] API Swagger docs
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
