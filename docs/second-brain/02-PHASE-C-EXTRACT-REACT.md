# Фаза C: Extract & React

**Цель:** Система проактивно извлекает события из переписки и предлагает действия.

**Продолжительность:** 2-3 недели

**Бизнес-ценность:** Пользователь не пропускает договорённости, обещания автоматически становятся напоминаниями.

---

## Неделя 3: Сущности и базовый pipeline

### Задача C1.1: ExtractedEvent Entity ✅

```typescript
// packages/entities/src/extracted-event.entity.ts

export enum ExtractedEventType {
  MEETING = 'meeting',           // "созвонимся завтра в 15:00"
  PROMISE_BY_ME = 'promise_by_me',     // "я пришлю завтра"
  PROMISE_BY_THEM = 'promise_by_them', // собеседник обещал
  TASK = 'task',                 // "можешь глянуть документ?"
  FACT = 'fact',                 // "у меня ДР 15 марта"
  CANCELLATION = 'cancellation', // "давай перенесём"
}

export enum ExtractedEventStatus {
  PENDING = 'pending',           // Ожидает обработки
  CONFIRMED = 'confirmed',       // Пользователь подтвердил
  REJECTED = 'rejected',         // Пользователь отклонил
  AUTO_PROCESSED = 'auto_processed', // Автоматически обработано
  EXPIRED = 'expired',           // Истекло время подтверждения
}

@Entity('extracted_events')
export class ExtractedEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'source_message_id', type: 'uuid' })
  @Index()
  sourceMessageId: string;

  @Column({ name: 'event_type', type: 'varchar', length: 30 })
  eventType: ExtractedEventType;

  @Column({ name: 'extracted_data', type: 'jsonb' })
  extractedData: ExtractedEventData;

  @Column({ type: 'decimal', precision: 3, scale: 2 })
  confidence: number;  // 0.00 - 1.00

  @Column({ type: 'varchar', length: 20, default: ExtractedEventStatus.PENDING })
  status: ExtractedEventStatus;

  // Context-Aware fields (Issue #62)
  @Column({ name: 'linked_event_id', type: 'uuid', nullable: true })
  linkedEventId: string | null;

  @Column({ name: 'needs_context', type: 'boolean', default: false })
  needsContext: boolean;

  @Column({ name: 'enrichment_data', type: 'jsonb', nullable: true })
  enrichmentData: object | null;
}
```

**Acceptance Criteria:**
- [x] Entity создана и экспортирована из @pkg/entities
- [x] Миграция применена без ошибок
- [x] CRUD операции работают

---

### Задача C1.3: SecondBrainExtractionService ✅

```typescript
@Injectable()
export class SecondBrainExtractionService {
  async extractFromMessage(message: Message, entityName: string): Promise<ExtractedEvent[]> {
    if (message.content.length < 20) {
      return [];
    }

    const { data } = await this.claudeAgentService.call<ExtractionResult>({
      mode: 'oneshot',
      taskType: 'event_extraction',
      prompt: this.buildExtractionPrompt(message.content, entityName),
      schema: this.schema,
      model: 'haiku',
    });

    const events: ExtractedEvent[] = [];

    for (const extracted of data.events) {
      if (extracted.confidence < 0.5) continue;

      const event = this.extractedEventRepo.create({
        sourceMessageId: message.id,
        eventType: extracted.type,
        extractedData: extracted.data,
        confidence: extracted.confidence,
        status: ExtractedEventStatus.PENDING,
      });

      events.push(await this.extractedEventRepo.save(event));
    }

    return events;
  }
}
```

**Acceptance Criteria:**
- [x] Сервис извлекает события из сообщений
- [x] Confidence scoring работает
- [x] События сохраняются в БД
- [x] Batch processing работает

---

## Неделя 4: Notifications

### Задача C2.3: NotificationService ✅

```typescript
@Injectable()
export class NotificationService {
  async notifyAboutEvent(event: ExtractedEvent): Promise<void> {
    const message = this.formatEventNotification(event);
    const buttons = this.getEventButtons(event);

    await this.telegramNotifier.sendWithButtons(message, buttons);

    await this.extractedEventRepo.update(event.id, {
      notificationSentAt: new Date(),
    });
  }

  private calculatePriority(event: ExtractedEvent): 'high' | 'medium' | 'low' {
    if (event.eventType === 'cancellation') return 'high';
    if (event.confidence > 0.9 && event.eventType === 'meeting') {
      // Check if meeting is within 24 hours
      return 'high';
    }
    if (event.eventType === 'task') return 'medium';
    return 'low';
  }
}
```

---

## Неделя 5: Scheduled Jobs

### Задача C3.1: NotificationSchedulerService ✅

```typescript
@Injectable()
export class NotificationSchedulerService {
  @Cron('*/5 * * * *')
  async processHighPriorityEvents(): Promise<void> {
    await this.notificationService.processHighPriorityEvents();
  }

  @Cron('0 * * * *')
  async sendHourlyDigest(): Promise<void> {
    await this.digestService.sendHourlyDigest();
  }

  @Cron('0 21 * * *', { timeZone: 'Europe/Moscow' })
  async sendDailyDigest(): Promise<void> {
    await this.digestService.sendDailyDigest();
  }

  @Cron('0 8 * * *', { timeZone: 'Europe/Moscow' })
  async sendMorningBrief(): Promise<void> {
    await this.digestService.sendMorningBrief();
  }

  @Cron('0 3 * * *')
  async expireOldEvents(): Promise<void> {
    await this.notificationService.expireOldPendingEvents();
  }
}
```

---

## Улучшения Phase C (Post-MVP)

### Issue #61: Carousel UX ✅ COMPLETED

**Проблема:** Digest показывает список с "Подтвердить все / Игнорировать все". Нельзя обработать по одному.

**Решение:** Carousel с пошаговой навигацией:

```
📋 События (1/10)
─────────────────
📋 Задача • 🎯 Высокий приоритет
👤 От: Иван Петров
📝 подготовить отчёт
─────────────────
[◀️ Назад] [✅ Да] [❌ Нет] [▶️ Далее]
```

**Completed in PR #63:**
- [x] Carousel state в Redis
- [x] `editMessageText` при навигации
- [x] Пропуск обработанных событий
- [x] Исправлено дублирование уведомлений

---

### Issue #62: Context-Aware Extraction ✅ COMPLETED

**Проблема:** "приступить к задаче" — к КАКОЙ задаче?

**Решение:** Двухфазная архитектура:

```
┌─────────────────────────────────────────────────────────────┐
│              Initial LLM Extraction (Haiku)                  │
│  - Извлекает события                                        │
│  - Помечает абстрактные как "needs_enrichment"              │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
     ┌────────────────┐             ┌────────────────┐
     │ Конкретное     │             │ Абстрактное    │
     │ → сохранить    │             │ → обогатить    │
     └────────────────┘             └────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────┐
                              │   Context Enrichment        │
                              │   1. Search history         │
                              │   2. Find linked events     │
                              │   3. LLM synthesis (Sonnet) │
                              └─────────────────────────────┘
```

**Completed in PR #64:**
- [x] Поля `linkedEventId`, `needsContext`, `enrichmentData`
- [x] ContextEnrichmentService
- [x] `tg://user?id=X` ссылки
- [x] Deep link на исходное сообщение
- [x] Endpoints: POST /enrich, GET /queue/stats

---

## Deliverables

1. **Database:**
   - [x] ExtractedEvent entity и миграция

2. **Services:**
   - [x] SecondBrainExtractionService
   - [x] NotificationService
   - [x] DigestService
   - [x] DigestActionStoreService (Redis)

3. **API:**
   - [x] GET /extracted-events
   - [x] GET /extracted-events/:id
   - [x] POST /extracted-events/:id/confirm
   - [x] POST /extracted-events/:id/reject
   - [x] GET /digest-actions/:shortId

4. **Telegram:**
   - [x] Callback handlers (d_c:/d_r: format)
   - [x] Morning brief
   - [x] Hourly/daily digests
   - [x] Batch confirm/reject через Redis

5. **Scheduled Jobs:**
   - [x] High-priority events (every 5 min)
   - [x] Hourly digest
   - [x] Daily digest (21:00 MSK)
   - [x] Morning brief (08:00 MSK)
   - [x] Expire old events (03:00)
