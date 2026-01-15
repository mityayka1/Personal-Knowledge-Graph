# PKG Second Brain — Implementation Checklist

> Краткий чеклист для отслеживания прогресса. Детали в [ROADMAP_SECOND_BRAIN.md](./ROADMAP_SECOND_BRAIN.md)

## Pre-requisites

- [ ] Верификация миграции Agent SDK
  - [ ] Директория `claude-cli/` удалена
  - [ ] Нет импортов ClaudeCliService
  - [ ] Все тесты проходят
  - [ ] Приложение запускается

---

## Phase B: Recall & Prepare (Week 1-2)

### Week 1: API

#### B1.1 Верификация (Day 1)
- [ ] Проверить отсутствие claude-cli
- [ ] Grep по ClaudeCliService = 0 результатов
- [ ] `pnpm test` проходит

#### B1.2 AgentController (Day 1)
- [ ] Controller создан
- [ ] DTOs с валидацией
- [ ] Swagger документация

#### B1.3 Recall Endpoint (Day 2-3)
- [ ] POST /agent/recall работает
- [ ] Итеративный поиск (видно tool calls в логах)
- [ ] Ответ содержит sources
- [ ] Фильтрация по entityId
- [ ] Timeout обработка

#### B1.4 Recall Tests (Day 3)
- [ ] E2E тест: успешный поиск
- [ ] E2E тест: maxTurns limit
- [ ] E2E тест: пустой результат

#### B1.5 Prepare Endpoint (Day 4-5)
- [ ] POST /agent/prepare/:entityId работает
- [ ] Brief содержит все секции
- [ ] Context влияет на suggestedTopics

### Week 2: Telegram

#### B2.1 Telegram Handler (Day 6-7)
- [ ] /recall команда
- [ ] /prepare команда
- [ ] Natural language detection

#### B2.2 Bot Commands (Day 7)
- [ ] Команды зарегистрированы
- [ ] Help message

#### B2.3 E2E Testing (Day 8-10)
- [ ] Тест на реальных данных
- [ ] Performance < 30 сек
- [ ] Error handling

#### B2.4 Metrics (Day 10)
- [ ] Логирование запросов
- [ ] Usage tracking

---

## Phase C: Extract & React (Week 3-5)

### Week 3: Entities

#### C1.1 ExtractedEvent Entity (Day 11-12)
- [ ] Entity создана
- [ ] Миграция применена
- [ ] CRUD работает

#### C1.2 Миграция БД (Day 12)
- [ ] Таблица extracted_events
- [ ] Индексы созданы
- [ ] Enum types

#### C1.3 EventExtractionService (Day 13-15)
- [ ] extractFromMessage работает
- [ ] Confidence scoring
- [ ] Batch processing
- [ ] JSON Schema для extraction

### Week 4: Notifications

#### C2.1 Message Processing Queue (Day 16-17)
- [ ] BullMQ queue настроена
- [ ] Event extraction в pipeline
- [ ] Worker processor

#### C2.2 BullMQ Worker (Day 17)
- [ ] Processor создан
- [ ] Retry logic
- [ ] Error handling

#### C2.3 NotificationService (Day 18-19)
- [ ] notifyAboutEvent работает
- [ ] Priority calculation
- [ ] Digest aggregation

#### C2.4 Callback Handlers (Day 20-21)
- [ ] event_confirm handler
- [ ] event_reject handler
- [ ] event_reschedule handler
- [ ] event_remind handler

#### C2.5 API Endpoints (Day 21)
- [ ] GET /extracted-events
- [ ] POST /:id/confirm
- [ ] POST /:id/reject

### Week 5: Scheduled Jobs

#### C3.1 Cron Jobs (Day 22-24)
- [ ] High-priority processing (*/5 * * * *)
- [ ] Hourly digest (0 * * * *)
- [ ] Daily digest (0 21 * * *)
- [ ] Morning brief (0 8 * * *)
- [ ] Expire old events (0 3 * * *)

#### C3.2 DigestService (Day 24)
- [ ] sendMorningBrief
- [ ] sendHourlyDigest
- [ ] sendDailyDigest
- [ ] formatMorningBrief

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
