# Unified Extraction Agent — Implementation Plan

> **Статус:** 🔄 В работе
> **Предшественник:** Context-Aware Extraction (✅ Завершено)
> **Дата:** 2025-01-28

---

## Проблема

Сейчас `FactExtractionProcessor` запускает **3 параллельных extraction flow** на один и тот же набор сообщений:

```
FactExtractionProcessor.process()
├── 1. FactExtractionService.extractFactsAgentBatch()     → EntityFact (agent, 5 tools)
├── 2. EventExtractionService.extractEventsBatch()         → EntityEvent (oneshot, legacy)
└── 3. SecondBrainExtractionService.extractFromMessages()  → ExtractedEvent (oneshot, 6 types)
```

**Проблемы:**
- 3 отдельных LLM-вызова на один batch сообщений → 3x стоимость
- Дублирование контекста: каждый flow строит свой prompt с теми же сообщениями
- Несогласованность: факт-агент видит tool results, а event oneshot — нет
- `EventExtractionService` (legacy) дублирует функциональность SecondBrain
- Разная архитектура: agent mode vs oneshot vs oneshot — сложно поддерживать

---

## Решение

**Один агент с полным набором tools** заменяет все 3 flow:

```
FactExtractionProcessor.process()
└── UnifiedExtractionService.extract()  → EntityFact + ExtractedEvent (agent, 6 tools)
```

Агент получает **секционированные инструкции** (`§FACTS` + `§EVENTS`) и 6 MCP-tools:
- 5 существующих: `get_entity_context`, `find_entity_by_name`, `create_fact`, `create_relation`, `create_pending_entity`
- 1 новый: `create_event`

---

## Шаг 1: Новый tool `create_event`

**Файл:** `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts`

### 1.1 Добавить tool в ExtractionToolsProvider

```typescript
tool('create_event',
  `Создать событие (встреча, обещание, дедлайн, день рождения и т.д.)

   Типы: meeting, promise_by_me, promise_by_them, deadline, birthday, general

   ПРАВИЛА ОБЕЩАНИЙ:
   - promise_by_me: автор ИСХОДЯЩЕГО сообщения обещает что-то сделать
   - promise_by_them: автор ВХОДЯЩЕГО сообщения обещает что-то сделать
   - ОПРЕДЕЛЯЙ тип ТОЛЬКО по isOutgoing флагу сообщения, НЕ по тексту

   АБСТРАКТНЫЕ СОБЫТИЯ (needsEnrichment=true):
   - "давай встретимся" без даты → meeting + needsEnrichment
   - "надо обсудить" без деталей → general + needsEnrichment`,
  {
    eventType: z.enum(['meeting', 'promise_by_me', 'promise_by_them', 'deadline', 'birthday', 'general'])
      .describe('Тип события'),
    title: z.string().describe('Краткое название события'),
    description: z.string().optional().describe('Подробное описание'),
    date: z.string().optional().describe('Дата/время ISO 8601 если известна'),
    entityId: z.string().uuid().describe('ID сущности-владельца события'),
    sourceMessageId: z.string().uuid().describe('ID исходного сообщения'),
    confidence: z.number().min(0).max(1).describe('Уверенность 0-1'),
    needsEnrichment: z.boolean().default(false)
      .describe('true если событие абстрактное (нет даты/деталей) и требует уточнения'),
    promiseToEntityId: z.string().uuid().optional()
      .describe('ID сущности-получателя обещания (для promise_by_me)'),
    metadata: z.record(z.unknown()).optional()
      .describe('Доп. данные (participants, location и т.д.)'),
  },
  async (args) => {
    // 1. Создать ExtractedEvent со статусом PENDING
    const event = await this.extractedEventService.create({
      eventType: args.eventType,
      title: args.title,
      description: args.description,
      eventDate: args.date ? new Date(args.date) : undefined,
      entityId: args.entityId,
      sourceMessageId: args.sourceMessageId,
      confidence: args.confidence,
      status: 'pending',
      needsEnrichment: args.needsEnrichment,
      promiseToEntityId: args.promiseToEntityId,
      metadata: args.metadata,
    });

    // 2. Если абстрактное — поставить в очередь обогащения
    if (args.needsEnrichment) {
      await this.enrichmentQueueService.queueForEnrichment(event.id);
    }

    return toolSuccess({ eventId: event.id, status: 'pending', queued: args.needsEnrichment });
  }
)
```

### 1.2 Зависимости для ExtractionToolsProvider

Добавить в конструктор:
- `ExtractedEventService` (создание событий)
- `EnrichmentQueueService` (очередь обогащения)

**Файл:** `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts`

```typescript
constructor(
  // ...existing deps...
  private readonly extractedEventService: ExtractedEventService,  // NEW
  private readonly enrichmentQueueService: EnrichmentQueueService, // NEW
) {}
```

### 1.3 Обновить ExtractionModule

**Файл:** `apps/pkg-core/src/modules/extraction/extraction.module.ts`

Добавить `ExtractedEventService` и `EnrichmentQueueService` в providers/imports.

---

## Шаг 2: Unified Extraction Service

**Новый файл:** `apps/pkg-core/src/modules/extraction/unified-extraction.service.ts`

### 2.1 Сервис

```typescript
@Injectable()
export class UnifiedExtractionService {
  private readonly logger = new Logger(UnifiedExtractionService.name);

  constructor(
    private readonly extractionToolsProvider: ExtractionToolsProvider,
    private readonly claudeAgentService: ClaudeAgentService,
    private readonly entityFactService: EntityFactService,
    private readonly entityRelationService: EntityRelationService,
    private readonly promiseRecipientService: PromiseRecipientService,
  ) {}

  async extract(params: UnifiedExtractionParams): Promise<UnifiedExtractionResult> {
    const { entityId, entityName, messages, interactionId } = params;

    // 1. Собрать контекст
    const entityContext = await this.entityFactService.getContextForExtraction(entityId);
    const relationsContext = await this.buildRelationsContext(entityId);

    // 2. Обогатить сообщения данными о reply-to и promise recipients
    const enrichedMessages = await this.enrichMessages(messages, interactionId, entityId);

    // 3. Построить prompt
    const prompt = this.buildUnifiedPrompt({
      entityName, entityContext, relationsContext,
      messages: enrichedMessages, interactionId,
    });

    // 4. Создать MCP сервер с extraction context
    const extractionContext = { messageId: messages[0]?.id, interactionId };
    const mcpServer = this.extractionToolsProvider.createMcpServer(extractionContext);
    const toolNames = this.extractionToolsProvider.getToolNames();

    // 5. Вызвать агента
    this.logger.debug(`[unified-extraction] Prompt:\n${prompt}`);

    const { data, usage, turns, toolsUsed } = await this.claudeAgentService.call<UnifiedExtractionResponse>({
      mode: 'agent',
      taskType: 'unified_extraction',
      prompt,
      model: 'haiku',
      maxTurns: 15,
      timeout: 180_000,
      referenceType: 'interaction',
      referenceId: interactionId,
      customMcp: { name: 'extraction-tools', server: mcpServer, toolNames },
      outputFormat: {
        type: 'json_schema',
        schema: UNIFIED_EXTRACTION_SCHEMA,
        strict: true,
      },
    });

    // 6. Логировать результат
    this.logger.log(
      `[unified-extraction] Done: ${data?.factsCreated ?? 0} facts, ` +
      `${data?.eventsCreated ?? 0} events, ${data?.relationsCreated ?? 0} relations | ` +
      `${turns} turns, tools: [${toolsUsed.join(', ')}] | ` +
      `tokens: ${usage?.input_tokens ?? 0}in/${usage?.output_tokens ?? 0}out`
    );

    return {
      factsCreated: data?.factsCreated ?? 0,
      eventsCreated: data?.eventsCreated ?? 0,
      relationsCreated: data?.relationsCreated ?? 0,
      pendingEntities: data?.pendingEntities ?? 0,
      turns,
      toolsUsed,
    };
  }
}
```

### 2.2 Метод enrichMessages

Перенос логики из `FactExtractionProcessor` — обогащение сообщений данными о reply-to и promise recipients:

```typescript
private async enrichMessages(
  messages: FormattedMessage[],
  interactionId: string,
  defaultEntityId: string,
): Promise<EnrichedMessage[]> {
  const replyToInfoMap = await this.promiseRecipientService.loadReplyToInfo(
    messages.filter(m => m.replyToSourceMessageId),
    interactionId,
  );

  return Promise.all(messages.map(async (m) => {
    const replyToInfo = m.replyToSourceMessageId
      ? replyToInfoMap.get(m.replyToSourceMessageId)
      : undefined;

    const messageEntityId = m.senderEntityId || defaultEntityId;

    const promiseToEntityId = await this.promiseRecipientService.resolveRecipient({
      interactionId,
      entityId: messageEntityId,
      isOutgoing: m.isOutgoing ?? false,
      replyToSenderEntityId: replyToInfo?.senderEntityId,
    });

    return {
      ...m,
      entityId: messageEntityId,
      promiseToEntityId,
      replyToContent: replyToInfo?.content,
      replyToSenderName: replyToInfo?.senderName,
    };
  }));
}
```

### 2.3 Unified Prompt Builder

```typescript
private buildUnifiedPrompt(params: PromptParams): string {
  const { entityName, entityContext, relationsContext, messages, interactionId } = params;

  const messageBlock = messages.map(m => {
    const direction = m.isOutgoing ? '→ ИСХОДЯЩЕЕ' : '← ВХОДЯЩЕЕ';
    const sender = m.senderEntityName || entityName;
    const reply = m.replyToContent
      ? `\n  [В ответ на: "${m.replyToContent.slice(0, 100)}..." от ${m.replyToSenderName}]`
      : '';
    const topic = m.topicName ? ` [Тема: ${m.topicName}]` : '';
    const promiseTo = m.promiseToEntityId
      ? `\n  [promiseToEntityId: ${m.promiseToEntityId}]`
      : '';
    return `[${m.timestamp}] ${direction} (${sender}, entityId: ${m.entityId}, msgId: ${m.id})${topic}${reply}${promiseTo}\n${m.content}`;
  }).join('\n\n');

  return `
Ты — агент извлечения знаний из переписки.
Анализируй сообщения и создавай факты, события и связи через доступные инструменты.

══════════════════════════════════════════
КОНТЕКСТ СОБЕСЕДНИКА (${entityName}):
${entityContext}
${relationsContext}
══════════════════════════════════════════

══════════════════════════════════════════
§ ФАКТЫ — правила извлечения
══════════════════════════════════════════
1. Факты принадлежат КОНКРЕТНЫМ сущностям.
2. "Маша работает в Сбере" → create_fact для Маши (найди через find_entity_by_name), НЕ для текущего контакта.
3. Если упомянут человек из связей — загрузи его контекст через get_entity_context.
4. Если упомянут новый человек — создай через create_pending_entity.
5. НЕ дублируй уже известные факты (сверяйся с контекстом выше).
6. Типы фактов: position, company, birthday, phone, email, location, education, hobby, family, preference.

══════════════════════════════════════════
§ СОБЫТИЯ — правила извлечения
══════════════════════════════════════════
1. ТИПЫ:
   - meeting: встречи, созвоны, переговоры
   - promise_by_me: обещание в ИСХОДЯЩЕМ сообщении (→)
   - promise_by_them: обещание во ВХОДЯЩЕМ сообщении (←)
   - deadline: дедлайны, сроки
   - birthday: дни рождения
   - general: прочие события

2. ОПРЕДЕЛЕНИЕ ТИПА ОБЕЩАНИЙ — ТОЛЬКО по направлению сообщения:
   - Сообщение "→ ИСХОДЯЩЕЕ" + обещание → promise_by_me
   - Сообщение "← ВХОДЯЩЕЕ" + обещание → promise_by_them
   - НИКОГДА не определяй тип обещания по тексту сообщения

3. АБСТРАКТНЫЕ СОБЫТИЯ:
   - Нет конкретной даты или деталей → needsEnrichment: true
   - "давай встретимся" → meeting + needsEnrichment: true
   - "встреча 15 января в 14:00" → meeting + needsEnrichment: false

4. PROMISE RECIPIENT:
   - Для promise_by_me: используй promiseToEntityId из метаданных сообщения
   - promiseToEntityId уже вычислен и указан в каждом сообщении

5. entityId и sourceMessageId:
   - entityId: используй entityId из метаданных конкретного сообщения
   - sourceMessageId: используй msgId из метаданных сообщения

══════════════════════════════════════════
§ СВЯЗИ — правила извлечения
══════════════════════════════════════════
1. "работает в ..." → create_relation(employment, [person/employee, org/employer])
2. "мой начальник" → create_relation(reporting, [me/subordinate, boss/manager])
3. "жена/муж" → create_relation(marriage, [spouse, spouse])
4. Не дублируй уже известные связи (сверяйся с контекстом).

══════════════════════════════════════════
СООБЩЕНИЯ ДЛЯ АНАЛИЗА:
══════════════════════════════════════════
${messageBlock}

══════════════════════════════════════════
ЗАДАНИЕ:
Проанализируй сообщения. Для каждого найденного факта, события или связи — вызови соответствующий инструмент.
После завершения заполни итоговую сводку.
`;
}
```

### 2.4 Output Schema

```typescript
const UNIFIED_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    factsCreated: { type: 'number', description: 'Количество созданных фактов' },
    eventsCreated: { type: 'number', description: 'Количество созданных событий' },
    relationsCreated: { type: 'number', description: 'Количество созданных связей' },
    pendingEntities: { type: 'number', description: 'Количество pending entities' },
    summary: { type: 'string', description: 'Краткая сводка что извлечено' },
  },
  required: ['factsCreated', 'eventsCreated', 'relationsCreated', 'pendingEntities', 'summary'],
};
```

### 2.5 Типы

**Файл:** `apps/pkg-core/src/modules/extraction/unified-extraction.types.ts`

```typescript
export interface UnifiedExtractionParams {
  entityId: string;
  entityName: string;
  messages: FormattedMessage[];
  interactionId: string;
}

export interface UnifiedExtractionResult {
  factsCreated: number;
  eventsCreated: number;
  relationsCreated: number;
  pendingEntities: number;
  turns: number;
  toolsUsed: string[];
}

export interface UnifiedExtractionResponse {
  factsCreated: number;
  eventsCreated: number;
  relationsCreated: number;
  pendingEntities: number;
  summary: string;
}
```

---

## Шаг 3: Упрощение FactExtractionProcessor

**Файл:** `apps/pkg-core/src/modules/job/processors/fact-extraction.processor.ts`

### 3.1 Замена 3 вызовов на 1

**Было:**
```typescript
// 1. Facts (agent)
const factResult = await this.factExtractionService.extractFactsAgentBatch({...});

// 2. Events legacy (oneshot)
const eventResult = await this.eventExtractionService.extractEventsBatch({...});

// 3. SecondBrain events (oneshot)
const replyToInfoMap = await this.promiseRecipientService.loadReplyToInfo(...);
const secondBrainMessages = await Promise.all(messages.map(...));
const secondBrainResults = await this.secondBrainExtractionService.extractFromMessages(...);
```

**Стало:**
```typescript
// Единый вызов
const result = await this.unifiedExtractionService.extract({
  entityId,
  entityName: entity.name,
  messages: formattedMessages,
  interactionId,
});

this.logger.log(
  `Extraction complete for interaction ${interactionId}: ` +
  `${result.factsCreated} facts, ${result.eventsCreated} events, ` +
  `${result.relationsCreated} relations`
);
```

### 3.2 Что остаётся в процессоре

- `ConversationGrouperService.formatMessages()` — препроцессинг, остаётся
- Entity lookup по `entityId` — остаётся
- Bot-message filtering — остаётся
- Job result logging — остаётся

### 3.3 Что удаляется из процессора

- Вызов `factExtractionService.extractFactsAgentBatch()`
- Вызов `eventExtractionService.extractEventsBatch()`
- Вся логика построения `secondBrainMessages` (replyToInfo, promiseRecipient resolve per message)
- Вызов `secondBrainExtractionService.extractFromMessages()`
- Зависимости: `FactExtractionService`, `EventExtractionService`, `SecondBrainExtractionService`, `PromiseRecipientService` — заменяются на `UnifiedExtractionService`

---

## Шаг 4: Логирование

### 4.1 Уровни логов

| Что | Уровень | Где |
|-----|---------|-----|
| Prompt целиком | `debug` | `UnifiedExtractionService.extract()` |
| Tool calls агента | `debug` | `ClaudeAgentService.executeAgent()` (уже есть) |
| Результат (counters) | `log` | `UnifiedExtractionService.extract()` |
| ClaudeAgentRun entity | DB | `ClaudeAgentService` (уже есть, сохраняет inputPreview/outputPreview) |

### 4.2 Существующее логирование в ClaudeAgentService

`ClaudeAgentService.executeAgent()` уже логирует:
- Tool usage tracking (`processAssistantMessage` → toolsUsed array)
- `ClaudeAgentRun` entity в БД: taskType, model, tokens, cost, duration, toolsUsed, inputPreview (500 chars), outputPreview (500 chars)
- Достаточно добавить `taskType: 'unified_extraction'` в `ClaudeTaskType` enum

### 4.3 Новый taskType

**Файл:** `packages/entities/src/claude-agent-run.entity.ts`

Добавить `'unified_extraction'` в `ClaudeTaskType`.

---

## Шаг 5: Deprecation

### 5.1 Файлы для deprecation (не удаляем сразу)

| Файл | Действие |
|------|----------|
| `EventExtractionService` | Пометить `@deprecated`, удалить при следующем cleanup |
| `SecondBrainExtractionService.extractFromMessages()` | Пометить `@deprecated` |
| `SecondBrainExtractionService.extractFromMessage()` | Пометить `@deprecated` |
| `SecondBrainExtractionService.buildPrompt()` | Пометить `@deprecated` |

### 5.2 Что остаётся в SecondBrainExtractionService

Utility-методы, используемые другими сервисами:
- `normalizeEventData()` — нормализация данных событий
- `mapEventType()` — маппинг типов событий
- Эти методы могут переехать в `ExtractedEventService` или остаться как утилиты

---

## Файлы для модификации

### Новые файлы
```
apps/pkg-core/src/modules/extraction/
├── unified-extraction.service.ts     # Основной сервис
└── unified-extraction.types.ts       # Типы
```

### Модифицируемые файлы
```
apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts  # +create_event tool
apps/pkg-core/src/modules/extraction/extraction.module.ts                # +UnifiedExtractionService, +deps
apps/pkg-core/src/modules/job/processors/fact-extraction.processor.ts    # Упрощение до 1 вызова
packages/entities/src/claude-agent-run.entity.ts                         # +unified_extraction taskType
```

### Deprecated (не удаляем)
```
apps/pkg-core/src/modules/extraction/event-extraction.service.ts         # @deprecated
apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts  # extractFromMessages @deprecated
```

---

## Порядок реализации

```
Шаг 1 ──► Шаг 2 ──► Шаг 3 ──► Шаг 4 ──► Шаг 5
  │           │           │          │          │
  ▼           ▼           ▼          ▼          ▼
create_event  Unified     Processor  Logging    Deprecation
tool          Service     simplify   taskType   markers
```

---

## Verification

### Сборка
```bash
cd apps/pkg-core && pnpm build
```

### Тест tool create_event
1. Запустить `pnpm dev` на pkg-core
2. Отправить тестовое сообщение "Давай встретимся в пятницу в 14:00"
3. Проверить в БД: `SELECT * FROM extracted_events ORDER BY created_at DESC LIMIT 5;`
4. Убедиться что `status = 'pending'`, `event_type = 'meeting'`

### Тест unified flow
1. Отправить сообщение "Маша перешла в Сбер, обещала позвонить завтра"
2. Проверить:
   - Факт `company: Сбер` создан для Маши (не для контакта)
   - Событие `promise_by_them` создано с `needsEnrichment: false`
3. Логи: `LOG_LEVEL=debug pnpm dev` → видим полный prompt в stdout

### Тест promise direction
1. Отправить ИСХОДЯЩЕЕ: "Я пришлю документы завтра" → `promise_by_me`
2. Получить ВХОДЯЩЕЕ: "Пришлю документы завтра" → `promise_by_them`
3. Убедиться что тип определён по `isOutgoing`, не по тексту

### Тест абстрактных событий
1. "Надо бы встретиться" → `meeting` + `needsEnrichment: true`
2. Проверить: событие в очереди `enrichment` в BullMQ

### Проверка логов
```bash
# Debug: полный prompt
LOG_LEVEL=debug pnpm dev 2>&1 | grep "unified-extraction"

# В БД: agent runs
SELECT task_type, model, turns_count, tools_used, duration_ms,
       input_preview, output_preview
FROM claude_agent_runs
WHERE task_type = 'unified_extraction'
ORDER BY created_at DESC LIMIT 5;
```

---

## Риски и митигация

| Риск | Митигация |
|------|-----------|
| Агент не вызывает create_event | Чёткие секции §EVENTS в prompt + примеры в tool description |
| Неправильный promise type | isOutgoing в метаданных сообщения, rule в prompt повторён 2 раза |
| Timeout на большом batch | maxTurns: 15, timeout: 180s, batch messages уже группированы |
| Агент путает entityId | Каждое сообщение содержит entityId и msgId в метаданных |
| Потеря функциональности при замене | Deprecated файлы сохранены, можно откатить |
| create_event создаёт дубликаты | ExtractedEvent не имеет dedup (в отличие от facts), но PENDING статус + title/date уникальность покрывают |
