# Conversation-Based Extraction — Design Document

> **Статус:** ✅ Completed — реализовано как SecondBrainExtractionService
> **Дата:** 2025-01-25
> **Проблема:** Факты извлекаются из одиночных сообщений без контекста беседы

---

## Проблема

Текущая реализация извлекает факты **по одному сообщению**, что приводит к:
- Бессмысленным фактам: `phone: "если есть номер тел"` вместо реального номера
- Потере контекста: "Ок, сделаю" без понимания ЧТО именно
- Невозможности связать ответ с вопросом из предыдущего сообщения

**Пример проблемы:**
```
[14:00] Заказчик: "Какой у тебя номер телефона, если есть?"
[14:01] Саша: "+7 999 123-45-67"
```

При обработке по одному:
- Сообщение 1: извлекается `phone: "если есть номер"` ❌
- Сообщение 2: номер извлекается, но без контекста кому принадлежит

При обработке беседой:
- LLM видит оба сообщения и понимает: номер принадлежит Саше ✅

---

## Решение: Двухуровневая группировка

### Уровень 1: Session (существует)
- **Gap:** 4 часа (настраивается)
- **Назначение:** Логическая сессия общения
- **Сущность:** `Interaction`

### Уровень 2: Conversation (новое)
- **Gap:** 20-30 минут (настраивается)
- **Назначение:** Мини-беседа для extraction
- **Сущность:** Виртуальная группировка (без отдельной таблицы)

```
Session (4h) ─┬─ Conversation 1 (30m) ─── [msg1, msg2, msg3]
              ├─ Conversation 2 (30m) ─── [msg4, msg5]
              └─ Conversation 3 (30m) ─── [msg6]
```

---

## Архитектурные решения

### 1. Границы беседы: Per-Chat

**Решение:** Беседа ограничена одним чатом (Interaction)

**Обоснование:**
- Приватные и публичные сообщения имеют разный контекст
- Проще реализация — не нужно мержить Interactions
- Человек намеренно выбирает где писать

### 2. Кросс-чат контекст

**Проблема:** Сообщения в разных чатах могут быть связаны контекстуально.

```
14:00 Групповой [я, Заказчик, Саша]: Заказчик → "Как там готовность?"
14:02 Личка [я, Саша]: Саша → "Готово наполовину"
```

**Решение:** При extraction добавляем "контекстное окно" из связанных чатов.

```typescript
// Extraction prompt structure
`БЕСЕДА (личный чат с Сашей):
${conversationMessages}

СВЯЗАННЫЙ КОНТЕКСТ (другие чаты с Сашей за последние 30 мин):
${crossChatContext}

ИЗВЕСТНЫЕ ФАКТЫ О САШЕ:
${entityFacts}
`
```

**Алгоритм получения кросс-чат контекста:**
1. Определяем участников текущей беседы
2. Ищем сообщения за последние N минут (настраивается, default 30)
3. Из других Interactions где участвуют те же сущности
4. Добавляем как supplementary context в prompt

### 3. Контекст сущности

При extraction передаём существующие знания о сущности:
- Текущие факты (должность, компания, etc.)
- История фактов (если релевантна)
- Связи с другими сущностями

Это помогает LLM правильно атрибутировать и интерпретировать факты.

### 4. Триггер extraction

**Механизм:** BullMQ delayed jobs

```
Новое сообщение → Отменить предыдущий delayed job → Создать новый (delay=30min)
                                                            ↓
                                            Job срабатывает → Беседа "закрыта"
                                                            ↓
                                                    Extraction запускается
```

**Преимущества:**
- Минимум "застрявших" бесед
- Атомарные операции через BullMQ API
- Уже частично реализовано для 4h sessions

---

## Итерации реализации

### Итерация 1: Базовая группировка (MVP)

1. Добавить настройку `extraction.conversationGapMinutes` (default: 30)
2. Модифицировать `JobService` для группировки messages в conversations
3. Создать `extractFromConversation()` вместо `extractFromMessage()`
4. Передавать entity context в extraction prompt
5. Unit/Integration тесты

### Итерация 2: Кросс-чат контекст

1. Реализовать `getCrossChatContext(entityIds, timeWindow)`
2. Добавить в extraction prompt
3. Настройка размера окна

### Итерация 3: Тематическое разбиение (Post-MVP)

1. Pre-processing agent для разбиения большой беседы по темам
2. Параллельная обработка тематических сегментов
3. Агрегация результатов

---

## Структура данных

### Новые настройки

```typescript
// settings.service.ts
{
  key: 'extraction.conversationGapMinutes',
  value: 30,
  description: 'Порог разделения бесед в минутах для extraction',
  category: 'extraction',
}

{
  key: 'extraction.crossChatContextMinutes',
  value: 30,
  description: 'Окно для поиска кросс-чат контекста',
  category: 'extraction',
}
```

### ExtractionJobData (расширение)

```typescript
interface ConversationGroup {
  messages: MessageData[];
  startedAt: Date;
  endedAt: Date;
  participantEntityIds: string[];
}

interface ExtractionJobData {
  interactionId: string;
  entityId: string;
  // Новое: группировка по беседам
  conversations: ConversationGroup[];
  // Legacy: для обратной совместимости
  messages?: MessageData[];
}
```

---

## Prompt Structure (Draft)

```
ТИП ЧАТА: ${chatType} "${chatName}"
УЧАСТНИКИ: ${participants}
ДАТА: ${today}

═══════════════════════════════════════════════════════════════
ИЗВЕСТНЫЕ ФАКТЫ О СОБЕСЕДНИКЕ (${entityName}):
${entityFacts || 'Нет сохранённых фактов'}
═══════════════════════════════════════════════════════════════

СВЯЗАННЫЙ КОНТЕКСТ (другие чаты за последние ${contextWindow} мин):
${crossChatContext || 'Нет связанного контекста'}

═══════════════════════════════════════════════════════════════
БЕСЕДА:
${formattedConversation}
═══════════════════════════════════════════════════════════════

Проанализируй БЕСЕДУ ЦЕЛИКОМ и извлеки факты/события.
Используй связанный контекст для понимания отсылок.
...
```

---

## Subject Resolution (Определение субъекта факта)

### Проблема

Факт может относиться НЕ к автору сообщения:

```
Марина: "У Игоря день рождения 10 августа"
```

Факт `birthday: "10 августа"` относится к Игорю, не к Марине.

### Решение: Двухэтапное извлечение

**Этап 1: Extraction с упоминанием субъекта**

LLM извлекает факт с указанием субъекта в тексте:
```json
{
  "factType": "birthday",
  "value": "10 августа",
  "subjectMention": "Игорь",
  "confidence": 0.9
}
```

**Этап 2: Entity Resolution для субъекта**

| subjectMention | Результат | Действие |
|----------------|-----------|----------|
| Найден точно (1 match) | `entityId: "xxx"` | Привязать факт |
| Найдено несколько | `candidates: [...]` | Запросить подтверждение |
| Не найден | `null` | Создать pending или отложить |
| Автор сообщения | Текущая entity | Привязать факт |

### Матрица решений

| Уверенность | Entity найдена | Действие |
|-------------|----------------|----------|
| ≥ 0.8 | Да (1 match) | Авто-создать факт |
| ≥ 0.8 | Несколько | Подтверждение: "О ком?" |
| < 0.8 | Да | Подтверждение: "Верно?" |
| < 0.8 | Нет | Отложить или отбросить |

---

## Единый флоу подтверждений

### Мотивация

Вместо нескольких отдельных механизмов (PendingEntityResolution, PendingFact, etc.) — единая система подтверждений.

### Типы подтверждений

| Type | Триггер | Автоматизация |
|------|---------|---------------|
| `identifier_attribution` | Номер/email **в тексте** сообщения | Спросить: "К кому относится?" |
| `entity_merge` | Похожие identifiers у разных entities | Спросить: "Объединить?" |
| `fact_subject` | Факт о третьем лице | Спросить: "О ком факт?" |
| `fact_value` | Низкая уверенность | Спросить: "Верно?" |

**Важно:** Новый `telegram_id` при первом сообщении → автоматически создаём entity, НЕ спрашиваем.

### Entity: PendingConfirmation

```typescript
@Entity('pending_confirmations')
export class PendingConfirmation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 50 })
  type: 'identifier_attribution' | 'entity_merge' | 'fact_subject' | 'fact_value';

  @Column({ type: 'jsonb' })
  context: {
    title: string;           // "О ком факт?"
    description: string;     // Описание ситуации
    sourceQuote?: string;    // Цитата из сообщения
  };

  @Column({ type: 'jsonb' })
  options: Array<{
    id: string;
    label: string;           // "Игорь Сидоров"
    sublabel?: string;       // "Коллега из Сбера"
    entityId?: string;
    isCreateNew?: boolean;
    isDecline?: boolean;
    isOther?: boolean;
  }>;

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  confidence: number;

  @Column({ length: 20, default: 'pending' })
  status: 'pending' | 'confirmed' | 'declined' | 'expired';

  // Связи
  @Column({ type: 'uuid', nullable: true })
  sourceMessageId: string | null;

  @Column({ type: 'uuid', nullable: true })
  sourcePendingFactId: string | null;

  // Результат
  @Column({ type: 'uuid', nullable: true })
  selectedOptionId: string | null;

  @Column({ type: 'timestamp', nullable: true })
  resolvedAt: Date | null;

  @Column({ length: 20, nullable: true })
  resolvedBy: 'user' | 'auto' | 'expired' | null;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  expiresAt: Date | null;
}
```

### ConfirmationService

```typescript
@Injectable()
export class ConfirmationService {
  // Создание
  async create(dto: CreateConfirmationDto): Promise<PendingConfirmation>;

  // Обработка ответа (+ dispatch к type-specific handler)
  async resolve(id: string, optionId: string): Promise<void>;

  // Для Telegram UI
  async getPendingForUser(limit?: number): Promise<PendingConfirmation[]>;
}
```

### Telegram UI — Единый формат

```
❓ **О ком факт?**

Факт "день рождения: 10 августа" из сообщения Марины.

> "У Игоря день рождения 10 августа"

[Игорь Сидоров] [Марина Петрова]
[✏️ Другой...] [❌ Отклонить]
```

### Архитектура

```
                    ┌─────────────────────────────────┐
                    │     PendingConfirmation         │
                    │  (unified entity + service)     │
                    └───────────────┬─────────────────┘
                                    │
           ┌────────────────────────┼────────────────────────┐
           │                        │                        │
           ▼                        ▼                        ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ IdentifierAttrib │    │   FactSubject    │    │   EntityMerge    │
│     Handler      │    │     Handler      │    │     Handler      │
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

---

## Открытые вопросы

1. **Размер беседы:** Что делать если беседа очень большая (100+ сообщений)?
   - Вариант A: Truncate с приоритетом недавних
   - Вариант B: Итерация 3 — тематическое разбиение

2. **Приоритет контекстов:** Если кросс-чат контекст конфликтует с entity facts?
   - Предложение: Entity facts как baseline, кросс-чат как свежий контекст

---

## Связанные документы

- [Context-Aware Extraction Plan](./enchanted-spinning-dream.md) — предыдущий план (частично реализован)
- [Second Brain INDEX](../second-brain/INDEX.md) — общий roadmap
- [CLAUDE.md](../../CLAUDE.md) — правила проекта
