# План миграции SecondBrainExtraction → PendingApproval

## Проблема

- **Бот** показывает события из таблицы `extracted_event` (есть данные)
- **Mini App** показывает данные из таблицы `pending_approval` (пусто)
- Это две разные системы, не синхронизированные между собой

## Решение

**Полная миграция** на PendingApproval систему. Удаляем использование ExtractedEvent для новых событий.

## Маппинг типов

| ExtractedEvent Type | PendingApproval Type | Target Entity |
|---------------------|----------------------|---------------|
| `FACT` | `fact` | EntityFact (status=draft) |
| `TASK` | `task` | Activity (type=TASK, status=draft) |
| `PROMISE_BY_ME` | `commitment` | Commitment (type=PROMISE, from=owner) |
| `PROMISE_BY_THEM` | `commitment` | Commitment (type=REQUEST, from=contact) |
| `MEETING` | `commitment` | Commitment (type=MEETING) |
| `CANCELLATION` | — не извлекать | Удалить из extraction schema |

**Решения по спорным типам:**
- **MEETING** → Commitment с типом MEETING (встреча = обязательство по времени)
- **CANCELLATION** → Удалить из extraction (редко используется, усложняет логику)

---

## Шаги реализации

### Шаг 1: Добавить createDraftFact в DraftExtractionService

**Файл:** `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts`

1. Добавить интерфейс `ExtractedFact` в types файл
2. Добавить поле `facts: ExtractedFact[]` в `DraftExtractionInput`
3. Добавить метод `createDraftFact()` по аналогии с `createDraftTask()`
4. Добавить обработку facts в методе `createDrafts()`
5. Добавить счётчик `facts` в `DraftExtractionResult.counts`

```typescript
interface ExtractedFact {
  entityId: string;
  factType: string;
  value: string;
  sourceQuote?: string;
  confidence: number;
}
```

### Шаг 2: Добавить MEETING тип в Commitment

**Файл:** `packages/entities/src/commitment.entity.ts`

Проверить что CommitmentType включает MEETING. Если нет — добавить:

```typescript
export enum CommitmentType {
  PROMISE = 'promise',
  REQUEST = 'request',
  AGREEMENT = 'agreement',
  MEETING = 'meeting', // ← добавить если нет
}
```

### Шаг 3: Переписать SecondBrainExtractionService на DraftExtractionService

**Файл:** `apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts`

Изменить метод `extractFromConversation()`:

```typescript
async extractFromConversation(params): Promise<ConversationExtractionResult> {
  // ... существующая логика извлечения через Claude ...

  // ВМЕСТО сохранения в extracted_event:
  const result = await this.draftExtractionService.createDrafts({
    ownerEntityId: this.getOwnerEntityId(),
    facts: this.mapFacts(rawEvents, params),
    tasks: this.mapTasks(rawEvents),
    commitments: this.mapCommitments(rawEvents, params), // включает PROMISE + MEETING
    projects: [],
    sourceInteractionId: params.interactionId,
  });

  return {
    batchId: result.batchId,
    extractedCount: result.counts.facts + result.counts.tasks + result.counts.commitments,
  };
}
```

### Шаг 4: Удалить CANCELLATION из extraction schema

**Файл:** `apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts`

Убрать `CANCELLATION` из JSON Schema для LLM:
- Удалить из enum `type` в `SECOND_BRAIN_EXTRACTION_SCHEMA`
- Удалить из `CONVERSATION_EXTRACTION_SCHEMA`

### Шаг 5: Обновить DigestService

**Файл:** `apps/pkg-core/src/modules/notification/digest.service.ts`

Заменить запросы к ExtractedEvent на PendingApproval:

```typescript
// БЫЛО:
const events = await this.extractedEventRepo.find({ status: 'pending' });

// СТАЛО:
const { items } = await this.pendingApprovalService.list({ status: 'pending' });
```

### Шаг 6: Удалить старый carousel код

**Файлы для удаления/deprecation:**
- `apps/pkg-core/src/modules/notification/carousel.controller.ts` — удалить
- `apps/pkg-core/src/modules/notification/carousel-state.service.ts` — удалить
- `apps/telegram-adapter/src/bot/handlers/carousel-callback.handler.ts` — удалить `car_*` callbacks

**Бот использует только `pa_*` callbacks** из `daily-summary.handler.ts`.

### Шаг 7: Очистить старые данные

```sql
-- Пометить все старые события как expired
UPDATE extracted_events SET status = 'expired' WHERE status = 'pending';
```

---

## Файлы для изменения

| Файл | Изменение |
|------|-----------|
| `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts` | Добавить `createDraftFact()`, поле `facts` |
| `apps/pkg-core/src/modules/extraction/daily-synthesis-extraction.types.ts` | Добавить `ExtractedFact` интерфейс |
| `apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts` | Переписать на DraftExtractionService |
| `packages/entities/src/commitment.entity.ts` | Добавить MEETING тип если нет |
| `apps/pkg-core/src/modules/notification/digest.service.ts` | Использовать PendingApproval |
| `apps/pkg-core/src/modules/notification/carousel.controller.ts` | УДАЛИТЬ |
| `apps/pkg-core/src/modules/notification/carousel-state.service.ts` | УДАЛИТЬ |
| `apps/telegram-adapter/src/bot/handlers/carousel-callback.handler.ts` | УДАЛИТЬ |

---

## Проверка (Verification)

1. **Unit тесты:**
   ```bash
   cd apps/pkg-core
   pnpm test draft-extraction
   pnpm test second-brain-extraction
   ```

2. **E2E тест:**
   - Отправить сообщение с фактом в Telegram ("У меня ДР 15 марта")
   - Запустить extraction (через /daily или digest)
   - Проверить что Mini App показывает новое событие
   - Подтвердить через Mini App
   - Проверить что EntityFact создался

3. **Проверка бота:**
   - Получить digest в Telegram
   - Нажать "Открыть в приложении" — должен открыться Mini App
   - Кнопки "Да/Нет" используют `pa_*` callbacks

```bash
# Логи extraction
ssh mityayka@assistant.mityayka.ru
cd /opt/apps/pkg/docker
docker compose logs -f pkg-core | grep -E "(draft-extraction|pending-approval)"
```

---

## Порядок выполнения

1. ✅ Шаг 1: createDraftFact (инфраструктура)
2. ✅ Шаг 2: MEETING тип (entities)
3. ✅ Шаг 3: Переписать SecondBrainExtraction (основная логика)
4. ✅ Шаг 4: Удалить CANCELLATION (cleanup schema)
5. ✅ Шаг 5: DigestService (notifications)
6. ✅ Шаг 6: Удалить carousel код (cleanup)
7. ✅ Шаг 7: Очистить старые данные (migration)
8. ✅ Тестирование

**Оценка:** ~6-8 часов работы
