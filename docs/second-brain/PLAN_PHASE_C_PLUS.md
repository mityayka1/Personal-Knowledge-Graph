# Phase C+ Implementation Plan: UX Improvements

> Детальный план реализации улучшений UX для Second Brain

**Продолжительность:** 1-1.5 недели
**Результат:** Улучшенный UX уведомлений с Carousel навигацией и контекстным обогащением

---

## Executive Summary

Phase C+ фокусируется на двух ключевых улучшениях:

1. **Issue #61: Carousel UX** — пошаговая обработка событий вместо списка
2. **Issue #62: Context-Aware Extraction** — обогащение абстрактных событий контекстом

---

## Текущее состояние (Baseline)

### Что работает

| Компонент | Статус | Описание |
|-----------|--------|----------|
| NotificationService | ✅ | Отправка уведомлений, formatEventNotification |
| DigestActionStoreService | ✅ | Хранение event IDs в Redis с short ID |
| EventCallbackHandler | ✅ | Обработка d_c:, d_r:, d_rm:, d_rs:, d_rsd: |
| SecondBrainExtractionService | ✅ | Извлечение событий из сообщений |
| TelegramNotifierService | ✅ | Отправка в Telegram с кнопками |

### Ограничения текущей реализации

1. **Digest:** Показывает список событий с "Подтвердить все / Игнорировать все"
2. **Нет навигации:** Нельзя обработать события по одному
3. **Абстрактные события:** "приступить к задаче" без контекста бесполезны
4. **Нет ссылок:** Имена контактов не кликабельны, нет ссылки на сообщение

---

## Issue #61: Carousel UX

### Проблема

Текущий digest показывает список событий:
```
📋 Новые события:
1. Задача: подготовить отчёт
2. Встреча: завтра в 15:00
3. Обещание: отправить документы

[✅ Подтвердить все] [❌ Игнорировать все]
```

Пользователь не может:
- Обработать события по одному
- Пропустить событие и вернуться позже
- Видеть детали каждого события

### Решение: Carousel Interface

```
📋 События (1/10)
─────────────────
📋 Задача • 🎯 Высокий приоритет
👤 От: Иван Петров
📝 подготовить отчёт
─────────────────
[◀️ Назад] [✅ Да] [❌ Нет] [▶️ Далее]
```

### Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                    CarouselStateService                      │
│  - Redis хранение: carousel:{chatId}:{messageId}            │
│  - Данные: { eventIds: [], currentIndex: 0, processedIds: [] } │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
     ┌────────────────┐             ┌────────────────┐
     │ DigestService  │             │ EventCallback  │
     │ - startCarousel│             │ Handler        │
     │ - formatCard   │             │ - nav actions  │
     └────────────────┘             └────────────────┘
```

### Задачи

#### C+1.1: CarouselStateService (Day 1) ✅ COMPLETED

**Файл:** `apps/pkg-core/src/modules/notification/carousel-state.service.ts`

```typescript
interface CarouselState {
  eventIds: string[];        // Все event IDs в carousel
  currentIndex: number;      // Текущая позиция (0-based)
  processedIds: string[];    // Уже обработанные (confirm/reject)
  chatId: string;            // Telegram chat ID
  messageId: number;         // Telegram message ID для editMessage
  createdAt: number;         // Timestamp для TTL
}

@Injectable()
export class CarouselStateService {
  constructor(private redis: Redis) {}

  // Redis key: carousel:{uniqueId}
  // TTL: 24 hours

  async create(chatId: string, messageId: number, eventIds: string[]): Promise<string>;
  async get(carouselId: string): Promise<CarouselState | null>;
  async next(carouselId: string): Promise<{ event: ExtractedEvent; index: number; total: number } | null>;
  async prev(carouselId: string): Promise<{ event: ExtractedEvent; index: number; total: number } | null>;
  async markProcessed(carouselId: string, eventId: string): Promise<void>;
  async getCurrentEvent(carouselId: string): Promise<{ event: ExtractedEvent; index: number; total: number } | null>;
}
```

**Acceptance Criteria:**
- [x] Redis хранение с TTL 24h
- [x] next() пропускает processedIds
- [x] prev() пропускает processedIds
- [x] getCurrentEvent() возвращает текущее событие с индексом

#### C+1.2: Carousel Buttons Format (Day 1) ✅ COMPLETED

**Файл:** `apps/pkg-core/src/modules/notification/notification.service.ts`

Новый callback_data format:
```
car_n:<carouselId>   — next
car_p:<carouselId>   — prev
car_c:<carouselId>   — confirm current
car_r:<carouselId>   — reject current
```

**Функции:**
```typescript
private formatCarouselCard(event: ExtractedEvent, index: number, total: number): string;
private getCarouselButtons(carouselId: string): InlineKeyboardButton[][];
```

**Acceptance Criteria:**
- [x] Карточка показывает индекс (1/10)
- [x] Кнопки: [◀️] [✅] [❌] [▶️]
- [x] callback_data < 64 bytes

#### C+1.3: DigestService Carousel Mode (Day 2) ✅ COMPLETED

**Файл:** `apps/pkg-core/src/modules/notification/digest.service.ts`

```typescript
async sendDigestAsCarousel(events: ExtractedEvent[], chatId: string): Promise<void> {
  // 1. Отправить первую карточку
  // 2. Создать carousel state
  // 3. Сохранить messageId
}
```

**Изменения:**
- `sendHourlyDigest()` → использует carousel если events.length > 1
- `sendDailyDigest()` → использует carousel если events.length > 1

**Acceptance Criteria:**
- [x] Digest с 1 событием — обычный формат
- [x] Digest с 2+ событиями — carousel
- [x] Первая карточка отправляется корректно

#### C+1.4: Carousel Callback Handler (Day 2) ✅ COMPLETED

**Файл:** `apps/telegram-adapter/src/bot/handlers/carousel-callback.handler.ts`

```typescript
@Injectable()
export class CarouselCallbackHandler {
  canHandle(data: string): boolean {
    return data.startsWith('car_');
  }

  async handle(ctx: Context): Promise<void> {
    // car_n: → next, editMessageText
    // car_p: → prev, editMessageText
    // car_c: → confirm current, then next
    // car_r: → reject current, then next
  }
}
```

**Acceptance Criteria:**
- [x] Навигация работает (next/prev)
- [x] Confirm/reject обрабатывает текущее событие
- [x] После confirm/reject — автоматически next
- [x] В конце списка — финальное сообщение "Все события обработаны"

#### C+1.5: Fix Duplicate Notifications (Day 3) ✅ COMPLETED

**Проблема:** Событие может быть уведомлено дважды если cron job запускается во время обработки.

**Решение:**
```typescript
// В NotificationService.notifyAboutEvent()
// Добавить проверку перед отправкой:
const event = await this.extractedEventRepo.findOne({
  where: { id: eventId, notificationSentAt: IsNull() }
});
if (!event) return false; // Already notified
```

**Acceptance Criteria:**
- [x] Событие уведомляется только один раз
- [x] Race condition защищена

#### C+1.6: Tests (Day 3) ⚠️ PARTIAL

**Файлы:**
- `apps/pkg-core/src/modules/notification/carousel-state.service.spec.ts`
- `apps/telegram-adapter/src/bot/handlers/carousel-callback.handler.spec.ts`

**Acceptance Criteria:**
- [ ] Unit tests для CarouselStateService (TODO: add tests)
- [ ] Unit tests для CarouselCallbackHandler (TODO: add tests)
- [x] Integration test: полный flow carousel (tested manually via real Telegram)

---

## Issue #62: Context-Aware Extraction

### Проблема

Извлечённые события бесполезны без контекста:
- "приступить к задаче" — к КАКОЙ задаче?
- "отправлю завтра" — ЧТО отправлю?
- "перенести встречу" — КАКУЮ встречу?

### Решение: Двухфазная архитектура

```
┌─────────────────────────────────────────────────────────────┐
│              Phase 1: Initial Extraction (Haiku)             │
│  - Извлекает события                                        │
│  - Помечает абстрактные как needs_enrichment=true           │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
     ┌────────────────┐             ┌────────────────┐
     │ Конкретное     │             │ Абстрактное    │
     │ событие        │             │ needs_enrichment│
     │ → сохранить    │             │ → Phase 2       │
     └────────────────┘             └────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────┐
                              │   Phase 2: Context Enrichment │
                              │   1. Search recent messages   │
                              │   2. Find linked events       │
                              │   3. LLM synthesis (Sonnet)   │
                              └─────────────────────────────┘
                                              │
                              ┌───────────────┴───────────────┐
                              ▼                               ▼
                     ┌────────────────┐             ┌────────────────┐
                     │ Контекст найден│             │ Контекст не    │
                     │ → обогатить    │             │ найден         │
                     │ → linkedEventId│             │ → needsContext │
                     └────────────────┘             └────────────────┘
```

### Задачи

#### C+2.1: Database Migration (Day 4)

**Файл:** `apps/pkg-core/src/database/migrations/XXXXXX-AddExtractedEventContextFields.ts`

```sql
ALTER TABLE extracted_events
ADD COLUMN linked_event_id UUID REFERENCES extracted_events(id) ON DELETE SET NULL,
ADD COLUMN needs_context BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN enrichment_data JSONB;

CREATE INDEX idx_extracted_events_linked ON extracted_events(linked_event_id);
CREATE INDEX idx_extracted_events_needs_context ON extracted_events(needs_context) WHERE needs_context = true;
```

**Acceptance Criteria:**
- [ ] Миграция применяется без ошибок
- [ ] Существующие записи сохраняются
- [ ] Индексы созданы

#### C+2.2: Update ExtractedEvent Entity (Day 4)

**Файл:** `packages/entities/src/extracted-event.entity.ts`

```typescript
@Column({ name: 'linked_event_id', type: 'uuid', nullable: true })
linkedEventId: string | null;

@ManyToOne(() => ExtractedEvent, { nullable: true, onDelete: 'SET NULL' })
@JoinColumn({ name: 'linked_event_id' })
linkedEvent: ExtractedEvent | null;

@Column({ name: 'needs_context', type: 'boolean', default: false })
needsContext: boolean;

@Column({ name: 'enrichment_data', type: 'jsonb', nullable: true })
enrichmentData: {
  originalWhat?: string;     // Исходный текст до обогащения
  enrichedWhat?: string;     // Обогащённый текст
  contextSource?: string;    // Откуда взят контекст
  searchQuery?: string;      // Запрос для поиска контекста
} | null;
```

**Acceptance Criteria:**
- [ ] Entity обновлена
- [ ] TypeORM relation работает
- [ ] Экспорт из @pkg/entities

#### C+2.3: Update Extraction Prompt (Day 4)

**Файл:** `apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts`

Добавить в prompt:
```
ВАЖНО про абстрактные события:
- Если событие ссылается на что-то неизвестное ("та задача", "это", "отправлю"),
  добавь needsEnrichment: true
- Примеры абстрактных: "приступлю к задаче", "отправлю завтра", "перенести встречу"
- Примеры конкретных: "приступлю к отчёту за Q4", "отправлю презентацию завтра"
```

Обновить schema:
```typescript
needsEnrichment: {
  type: 'boolean',
  description: 'True if event references something unknown that needs context lookup',
},
```

**Acceptance Criteria:**
- [ ] Prompt обновлён
- [ ] Schema содержит needsEnrichment
- [ ] Абстрактные события помечаются корректно

#### C+2.4: ContextEnrichmentService (Day 5)

**Файл:** `apps/pkg-core/src/modules/extraction/context-enrichment.service.ts`

```typescript
@Injectable()
export class ContextEnrichmentService {
  constructor(
    private searchService: SearchService,
    private extractedEventRepo: Repository<ExtractedEvent>,
    private claudeAgentService: ClaudeAgentService,
  ) {}

  /**
   * Enrich abstract event with context from history
   */
  async enrichEvent(event: ExtractedEvent): Promise<ExtractedEvent> {
    // 1. Extract keywords from event
    const keywords = this.extractKeywords(event);

    // 2. Search recent messages with same entity
    const recentMessages = await this.searchService.searchMessages({
      query: keywords,
      entityId: event.entityId,
      limit: 10,
      period: { days: 7 },
    });

    // 3. Search recent extracted events
    const recentEvents = await this.extractedEventRepo.find({
      where: {
        entityId: event.entityId,
        createdAt: MoreThan(subDays(new Date(), 7)),
        id: Not(event.id),
      },
      order: { createdAt: 'DESC' },
      take: 5,
    });

    // 4. Use LLM to synthesize context
    const enriched = await this.synthesizeContext(event, recentMessages, recentEvents);

    // 5. Update event
    return this.extractedEventRepo.save({
      ...event,
      extractedData: enriched.data,
      linkedEventId: enriched.linkedEventId,
      needsContext: !enriched.contextFound,
      enrichmentData: enriched.metadata,
    });
  }

  private async synthesizeContext(
    event: ExtractedEvent,
    messages: Message[],
    events: ExtractedEvent[],
  ): Promise<EnrichmentResult> {
    // LLM call with Sonnet for better reasoning
  }
}
```

**Acceptance Criteria:**
- [ ] Поиск по истории работает
- [ ] Связывание с предыдущими событиями
- [ ] LLM обогащение контекста
- [ ] needsContext=true если контекст не найден

#### C+2.5: Enrichment Queue Integration (Day 5)

**Файл:** `apps/pkg-core/src/modules/notification/notification.processor.ts`

```typescript
// После извлечения событий, проверить needsEnrichment
for (const event of extractedEvents) {
  if (event.needsEnrichment) {
    await this.enrichmentQueue.add('enrich-event', { eventId: event.id });
  }
}
```

**Acceptance Criteria:**
- [ ] События с needsEnrichment попадают в очередь
- [ ] Обогащение выполняется асинхронно
- [ ] После обогащения событие готово к уведомлению

#### C+2.6: UX Improvements - Contact Links (Day 6)

**Файл:** `apps/pkg-core/src/modules/notification/notification.service.ts`

```typescript
private formatEventNotification(event: ExtractedEvent): string {
  // Получить telegram_user_id для контакта
  const telegramUserId = await this.getTelegramUserId(event.entityId);

  // Форматировать с ссылкой
  const contactLink = telegramUserId
    ? `<a href="tg://user?id=${telegramUserId}">${entityName}</a>`
    : entityName;

  return `<b>Задача от ${contactLink}:</b>\n${data.what}`;
}
```

**Acceptance Criteria:**
- [ ] Имена контактов кликабельны
- [ ] tg://user?id=X формат работает
- [ ] Fallback на plain text если нет telegram_id

#### C+2.7: UX Improvements - Message Deep Links (Day 6)

**Файл:** `apps/pkg-core/src/modules/notification/notification.service.ts`

```typescript
private formatEventNotification(event: ExtractedEvent): string {
  // Получить данные для deep link
  const message = await this.messageRepo.findOne({
    where: { id: event.sourceMessageId },
    relations: ['interaction'],
  });

  const chatId = message?.interaction?.sourceMetadata?.telegram_chat_id;
  const msgId = message?.sourceMessageId;

  // Deep link: https://t.me/c/CHAT_ID/MSG_ID (для приватных групп/чатов)
  // Или прямая ссылка для публичных каналов
  const messageLink = chatId && msgId
    ? `<a href="https://t.me/c/${chatId}/${msgId}">📎 Сообщение</a>`
    : '';

  return `${content}\n${messageLink}`;
}
```

**Acceptance Criteria:**
- [ ] Ссылка на исходное сообщение
- [ ] Правильный формат для приватных чатов
- [ ] Показ sourceQuote

#### C+2.8: UX for needsContext Events (Day 6)

**Файл:** `apps/pkg-core/src/modules/notification/notification.service.ts`

```typescript
private formatEventNotification(event: ExtractedEvent): string {
  let content = this.formatEventContent(event);

  // Предупреждение если контекст не найден
  if (event.needsContext) {
    content += '\n\n⚠️ <i>Контекст не найден. Уточните о чём речь.</i>';
  }

  return content;
}
```

**Acceptance Criteria:**
- [ ] События с needsContext показывают предупреждение
- [ ] Кнопка "Уточнить контекст" (опционально)

#### C+2.9: Tests (Day 7)

**Файлы:**
- `apps/pkg-core/src/modules/extraction/context-enrichment.service.spec.ts`
- Integration tests для enrichment flow

**Acceptance Criteria:**
- [ ] Unit tests для ContextEnrichmentService
- [ ] Test: абстрактное событие → обогащение → конкретное
- [ ] Test: контекст не найден → needsContext=true

---

## Timeline Summary

```
Day 1:  C+1.1 CarouselStateService
        C+1.2 Carousel Buttons Format

Day 2:  C+1.3 DigestService Carousel Mode
        C+1.4 Carousel Callback Handler

Day 3:  C+1.5 Fix Duplicate Notifications
        C+1.6 Carousel Tests

Day 4:  C+2.1 Database Migration
        C+2.2 Update ExtractedEvent Entity
        C+2.3 Update Extraction Prompt

Day 5:  C+2.4 ContextEnrichmentService
        C+2.5 Enrichment Queue Integration

Day 6:  C+2.6 UX - Contact Links
        C+2.7 UX - Message Deep Links
        C+2.8 UX for needsContext Events

Day 7:  C+2.9 Tests
        Final polish and PR
```

---

## API Changes

### New Endpoints

```
GET  /carousel/:carouselId          — Get carousel state
POST /carousel/:carouselId/next     — Navigate to next
POST /carousel/:carouselId/prev     — Navigate to prev
POST /extracted-events/:id/enrich   — Trigger enrichment
```

### Updated Callback Data Formats

```
Carousel:
  car_n:<carouselId>     — next
  car_p:<carouselId>     — prev
  car_c:<carouselId>     — confirm current
  car_r:<carouselId>     — reject current

Existing (unchanged):
  d_c:<shortId>          — confirm event(s)
  d_r:<shortId>          — reject event(s)
  d_rm:<shortId>         — remind
  d_rs:<shortId>         — show reschedule options
  d_rsd:<shortId>:<days> — reschedule with days
```

---

## Success Metrics

### Issue #61: Carousel UX ✅ COMPLETED (PR #63)
- [x] Пользователь может обработать события по одному
- [x] Навигация работает без ошибок
- [x] Нет дублирования уведомлений
- [x] Carousel завершается корректно

### Issue #62: Context-Aware Extraction (TODO)
- [ ] 80%+ абстрактных событий обогащаются успешно
- [ ] Ссылки на контакты кликабельны
- [ ] Deep links на сообщения работают
- [ ] needsContext события показывают предупреждение

---

## Risk Mitigation

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| Redis TTL истекает во время carousel | Низкая | TTL 24h, показать "Сессия истекла" |
| Telegram rate limits при editMessage | Низкая | Debounce навигации |
| LLM не находит контекст | Средняя | needsContext fallback |
| Deep links не работают для всех чатов | Средняя | Graceful fallback |

---

## Dependencies

### Issue #61 зависит от:
- DigestActionStoreService (готов)
- TelegramNotifierService (готов)
- Redis (готов)

### Issue #62 зависит от:
- SearchService (готов)
- ClaudeAgentService (готов)
- Message/Interaction relations (готов)

---

## Notes

- Issue #61 и #62 можно разрабатывать параллельно
- Issue #61 приоритетнее (больше user value быстрее)
- Issue #62 требует больше LLM вызовов (cost consideration)
