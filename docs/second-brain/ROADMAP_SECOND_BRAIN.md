# PKG Development Roadmap: Second Brain Implementation

> Пошаговый план развития Personal Knowledge Graph от текущего состояния до полноценной "второй памяти"

## Executive Summary

Этот документ описывает трёхфазный план развития PKG, который превратит систему из инструмента хранения данных в проактивного персонального ассистента. План построен по принципу "от быстрых побед к сложным фичам": сначала получаем работающий продукт, затем добавляем интеллект.

**Общая продолжительность:** 6-8 недель
**Результат:** Работающая "вторая память" с Recall, Prepare, Extract & React, и Act capabilities

---

## Текущее состояние (Baseline)

Прежде чем двигаться дальше, важно зафиксировать что уже работает.

### Готовая инфраструктура

| Компонент | Статус | Описание |
|-----------|--------|----------|
| ClaudeAgentService | ✅ Ready | Поддержка oneshot и agent modes |
| ToolsRegistryService | ✅ Ready | Категории: search, entities, events, context |
| SearchToolsProvider | ✅ Ready | `search_messages`, hybrid search |
| EntityToolsProvider | ✅ Ready | `list_entities`, `get_entity_details` |
| EventToolsProvider | ✅ Ready | `create_reminder`, `get_upcoming_events` |
| ContextToolsProvider | ✅ Ready | `get_entity_context` для meeting prep |
| EntityEventService | ✅ Ready | CRUD для событий/напоминаний |
| Hybrid Search | ✅ Ready | FTS + Vector + RRF |

### Что нужно проверить перед стартом

Перед началом работы над новыми фичами необходимо убедиться, что миграция на Agent SDK полностью завершена:

1. **Удалён старый модуль claude-cli/** — проверить отсутствие директории
2. **Все 4 сервиса мигрированы** — SummarizationService, EntityProfileService, ContextService, FactExtractionService используют ClaudeAgentService
3. **Нет ссылок на ClaudeCliService** — grep по кодовой базе
4. **Тесты проходят** — `pnpm test` в pkg-core

---

## Фаза B: Пилот Recall/Prepare

**Цель:** Получить работающий продукт для поиска информации и подготовки к встречам.

**Продолжительность:** 1.5-2 недели

**Бизнес-ценность:** Пользователь может задать вопрос "кто мне советовал юриста?" или "подготовь brief к встрече с Петром" и получить релевантный ответ.

### Неделя 1: API и базовая интеграция

#### День 1: Верификация и подготовка

**Задача B1.1: Верификация миграции Agent SDK**

Проверить что миграция завершена и старый код удалён.

```bash
# Проверки
ls -la apps/pkg-core/src/modules/claude-cli/  # Должна быть ошибка "No such file"
grep -r "ClaudeCliService" apps/pkg-core/src/  # 0 результатов
grep -r "claudeCliService" apps/pkg-core/src/  # 0 результатов
grep -r "claude-cli" apps/pkg-core/src/modules/ --include="*.ts"  # 0 результатов

# Запуск тестов
cd apps/pkg-core && pnpm test
```

Acceptance Criteria:
- [ ] Директория `claude-cli/` не существует
- [ ] Нет импортов ClaudeCliService в коде
- [ ] Все unit тесты проходят
- [ ] Приложение запускается без ошибок

**Задача B1.2: Создание AgentController**

Если ещё нет, создать контроллер для агентных запросов.

```typescript
// apps/pkg-core/src/modules/claude-agent/claude-agent.controller.ts

@Controller('agent')
export class ClaudeAgentController {
  constructor(
    private readonly agentService: ClaudeAgentService,
    private readonly toolsRegistry: ToolsRegistryService,
  ) {}

  @Post('recall')
  async recall(@Body() dto: RecallRequestDto): Promise<RecallResponseDto> {
    // Implementation
  }

  @Post('prepare/:entityId')
  async prepare(
    @Param('entityId') entityId: string,
    @Body() dto: PrepareRequestDto,
  ): Promise<PrepareResponseDto> {
    // Implementation
  }
}
```

Acceptance Criteria:
- [ ] Контроллер создан и зарегистрирован в модуле
- [ ] DTO классы определены с валидацией
- [ ] Swagger документация генерируется

#### День 2-3: Recall Endpoint

**Задача B1.3: Recall API Implementation**

Реализовать endpoint для поиска информации в естественном языке.

```typescript
// DTOs
export class RecallRequestDto {
  @IsString()
  @MinLength(3)
  query: string;  // "Кто советовал юриста по IP?"

  @IsOptional()
  @IsUUID()
  entityId?: string;  // Опциональный фильтр по контакту

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxTurns?: number;  // Лимит итераций агента (default: 10)
}

export class RecallResponseDto {
  answer: string;  // Текстовый ответ
  sources: RecallSource[];  // Источники информации
  usage: UsageStats;  // Токены и стоимость
}

interface RecallSource {
  type: 'message' | 'interaction' | 'entity';
  id: string;
  preview: string;
  timestamp?: string;
  entityName?: string;
}
```

```typescript
// Controller implementation
@Post('recall')
async recall(@Body() dto: RecallRequestDto): Promise<RecallResponseDto> {
  const mcpServer = this.toolsRegistry.createMcpServer(['search', 'entities']);
  
  const { data, usage, toolsUsed } = await this.agentService.call<string>({
    mode: 'agent',
    taskType: 'recall',
    prompt: this.buildRecallPrompt(dto.query, dto.entityId),
    toolCategories: ['search', 'entities'],
    maxTurns: dto.maxTurns || 10,
  });

  return {
    answer: data,
    sources: this.extractSources(toolsUsed),
    usage,
  };
}

private buildRecallPrompt(query: string, entityId?: string): string {
  let prompt = `Найди информацию по запросу пользователя: "${query}"

Используй инструменты поиска, чтобы найти релевантные сообщения и контакты.
Если первый поиск не даёт результатов, попробуй переформулировать запрос.
В ответе укажи конкретные факты и их источники.`;

  if (entityId) {
    prompt += `\n\nФокусируйся на информации, связанной с контактом ID: ${entityId}`;
  }

  return prompt;
}
```

Acceptance Criteria:
- [ ] POST /agent/recall принимает запросы
- [ ] Агент выполняет итеративный поиск (видно в логах tool calls)
- [ ] Ответ содержит текст и источники
- [ ] Работает фильтрация по entityId
- [ ] Timeout корректно обрабатывается

**Задача B1.4: Integration Test для Recall**

```typescript
// apps/pkg-core/test/agent-recall.e2e-spec.ts

describe('Agent Recall (e2e)', () => {
  it('should find information with iterative search', async () => {
    const response = await request(app.getHttpServer())
      .post('/agent/recall')
      .send({ query: 'кто работает в Сбере' })
      .expect(200);

    expect(response.body.answer).toBeDefined();
    expect(response.body.sources).toBeInstanceOf(Array);
  });

  it('should respect maxTurns limit', async () => {
    const response = await request(app.getHttpServer())
      .post('/agent/recall')
      .send({ query: 'несуществующая информация xyz123', maxTurns: 3 })
      .expect(200);

    // Should complete even if nothing found
    expect(response.body.answer).toContain('не найд');
  });
});
```

#### День 4-5: Prepare Endpoint

**Задача B1.5: Prepare API Implementation**

Реализовать endpoint для подготовки к встрече с контактом.

```typescript
// DTOs
export class PrepareRequestDto {
  @IsOptional()
  @IsString()
  context?: string;  // "Обсуждаем новый проект"

  @IsOptional()
  @IsBoolean()
  includeOpenItems?: boolean;  // Включить открытые вопросы (default: true)
}

export class PrepareResponseDto {
  entityId: string;
  entityName: string;
  brief: MeetingBrief;
  generatedAt: string;
  usage: UsageStats;
}

interface MeetingBrief {
  summary: string;  // Краткое описание отношений
  keyFacts: string[];  // Важные факты о контакте
  recentTopics: string[];  // Темы последних обсуждений
  openItems: OpenItem[];  // Открытые вопросы/обещания
  suggestedTopics: string[];  // Рекомендации что обсудить
}
```

```typescript
// Controller implementation
@Post('prepare/:entityId')
async prepare(
  @Param('entityId', ParseUUIDPipe) entityId: string,
  @Body() dto: PrepareRequestDto,
): Promise<PrepareResponseDto> {
  // Сначала получаем базовый контекст через существующий ContextService
  // Затем обогащаем через агента если нужен дополнительный поиск
  
  const mcpServer = this.toolsRegistry.createMcpServer(['search', 'entities', 'context', 'events']);
  
  const { data, usage } = await this.agentService.call<MeetingBrief>({
    mode: 'agent',
    taskType: 'meeting_prep',
    prompt: this.buildPreparePrompt(entityId, dto.context),
    toolCategories: ['search', 'entities', 'context', 'events'],
    maxTurns: 15,
  });

  const entity = await this.entityService.findOne(entityId);

  return {
    entityId,
    entityName: entity.name,
    brief: data,
    generatedAt: new Date().toISOString(),
    usage,
  };
}

private buildPreparePrompt(entityId: string, context?: string): string {
  let prompt = `Подготовь brief для встречи с контактом (ID: ${entityId}).

Используй инструменты чтобы собрать:
1. Основную информацию о контакте (get_entity_details)
2. Полный контекст отношений (get_entity_context)
3. Предстоящие события (get_upcoming_events)
4. Релевантные сообщения из истории (search_messages)

Сформируй структурированный brief с:
- Кратким описанием отношений
- Ключевыми фактами
- Темами последних обсуждений
- Открытыми вопросами
- Рекомендациями что обсудить`;

  if (context) {
    prompt += `\n\nКонтекст встречи: ${context}`;
  }

  return prompt;
}
```

Acceptance Criteria:
- [ ] POST /agent/prepare/:entityId работает
- [ ] Brief содержит все секции (summary, facts, topics, etc.)
- [ ] Агент использует несколько tools для сбора информации
- [ ] Context влияет на suggestedTopics

### Неделя 2: Telegram интеграция

#### День 6-7: Telegram Bot Handler

**Задача B2.1: Telegram Bot для Recall/Prepare**

Интегрировать агентные endpoints в Telegram бота для удобного доступа.

```typescript
// apps/telegram-adapter/src/bot/handlers/agent.handler.ts

@Injectable()
export class AgentHandler {
  constructor(
    private readonly httpService: HttpService,  // Для вызова pkg-core API
  ) {}

  /**
   * Handle /recall command
   * Usage: /recall кто советовал юриста?
   */
  async handleRecall(ctx: Context, query: string): Promise<void> {
    await ctx.reply('🔍 Ищу информацию...');

    try {
      const response = await this.httpService.post('/agent/recall', { query }).toPromise();
      const { answer, sources } = response.data;

      let message = `📋 **Результат поиска:**\n\n${answer}`;
      
      if (sources.length > 0) {
        message += '\n\n📎 **Источники:**';
        for (const source of sources.slice(0, 3)) {
          message += `\n• ${source.entityName || 'Сообщение'}: ${source.preview.slice(0, 50)}...`;
        }
      }

      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
      await ctx.reply('❌ Ошибка при поиске. Попробуйте переформулировать запрос.');
    }
  }

  /**
   * Handle /prepare command
   * Usage: /prepare Имя контакта
   * Or reply to message from contact with /prepare
   */
  async handlePrepare(ctx: Context, entityNameOrId: string): Promise<void> {
    await ctx.reply('📝 Готовлю brief...');

    try {
      // Сначала найти entity по имени
      const searchResponse = await this.httpService.get('/entities', {
        params: { search: entityNameOrId, limit: 1 }
      }).toPromise();

      if (searchResponse.data.items.length === 0) {
        await ctx.reply(`❌ Контакт "${entityNameOrId}" не найден`);
        return;
      }

      const entityId = searchResponse.data.items[0].id;
      const response = await this.httpService.post(`/agent/prepare/${entityId}`).toPromise();
      const { brief, entityName } = response.data;

      const message = this.formatBrief(entityName, brief);
      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
      await ctx.reply('❌ Ошибка при подготовке brief.');
    }
  }

  private formatBrief(name: string, brief: MeetingBrief): string {
    let msg = `📋 **Brief: ${name}**\n\n`;
    msg += `${brief.summary}\n\n`;

    if (brief.keyFacts.length > 0) {
      msg += '**Ключевые факты:**\n';
      brief.keyFacts.forEach(f => msg += `• ${f}\n`);
      msg += '\n';
    }

    if (brief.recentTopics.length > 0) {
      msg += '**Недавние темы:**\n';
      brief.recentTopics.forEach(t => msg += `• ${t}\n`);
      msg += '\n';
    }

    if (brief.openItems.length > 0) {
      msg += '⚠️ **Открытые вопросы:**\n';
      brief.openItems.forEach(i => msg += `• ${i.description}\n`);
      msg += '\n';
    }

    if (brief.suggestedTopics.length > 0) {
      msg += '💡 **Рекомендации:**\n';
      brief.suggestedTopics.forEach(t => msg += `• ${t}\n`);
    }

    return msg;
  }
}
```

**Задача B2.2: Команды бота**

```typescript
// Регистрация команд
bot.command('recall', async (ctx) => {
  const query = ctx.message.text.replace('/recall', '').trim();
  if (!query) {
    await ctx.reply('Использование: /recall <ваш вопрос>\nПример: /recall кто советовал юриста?');
    return;
  }
  await agentHandler.handleRecall(ctx, query);
});

bot.command('prepare', async (ctx) => {
  const name = ctx.message.text.replace('/prepare', '').trim();
  if (!name) {
    await ctx.reply('Использование: /prepare <имя контакта>\nПример: /prepare Петр Иванов');
    return;
  }
  await agentHandler.handlePrepare(ctx, name);
});

// Также можно обрабатывать как обычные сообщения
bot.hears(/^(найди|вспомни|кто|что|когда|где)/i, async (ctx) => {
  await agentHandler.handleRecall(ctx, ctx.message.text);
});
```

Acceptance Criteria:
- [ ] /recall команда работает
- [ ] /prepare команда работает
- [ ] Естественные запросы распознаются
- [ ] Форматирование Markdown корректное
- [ ] Ошибки обрабатываются gracefully

#### День 8-10: Тестирование и полировка

**Задача B2.3: End-to-End тестирование**

Провести тестирование на реальных данных.

```markdown
## Тест-кейсы для Recall

1. **Простой поиск по имени**
   - Запрос: "Что я обсуждал с Петром?"
   - Ожидание: Найдены сообщения с Петром, краткое резюме

2. **Поиск рекомендации**
   - Запрос: "Кто советовал хорошего стоматолога?"
   - Ожидание: Итеративный поиск с разными формулировками

3. **Поиск договорённости**
   - Запрос: "О чём мы договорились с Сергеем по проекту?"
   - Ожидание: Найдены решения и action items

4. **Несуществующая информация**
   - Запрос: "Кто рекомендовал астролога xyz123?"
   - Ожидание: Корректный ответ "информация не найдена"

## Тест-кейсы для Prepare

1. **Brief для активного контакта**
   - Контакт с множеством сообщений за последний месяц
   - Ожидание: Богатый brief с recent topics

2. **Brief для давнего контакта**
   - Последний контакт > 6 месяцев назад
   - Ожидание: Brief с акцентом на "давно не общались"

3. **Brief с контекстом**
   - Запрос: /prepare Петр (контекст: обсуждаем инвестиции)
   - Ожидание: suggestedTopics релевантны контексту
```

**Задача B2.4: Мониторинг и метрики**

```typescript
// Добавить логирование для анализа качества
@Injectable()
export class AgentMetricsService {
  async logRecallRequest(request: RecallRequestDto, response: RecallResponseDto, durationMs: number) {
    // Сохранить для анализа:
    // - Запрос пользователя
    // - Количество источников
    // - Использованные tokens
    // - Время ответа
    // - Какие tools использовались
  }
}
```

### Deliverables фазы B

По завершении фазы B должно быть готово:

1. **API Endpoints:**
   - POST /agent/recall — поиск информации
   - POST /agent/prepare/:entityId — meeting brief

2. **Telegram Bot:**
   - /recall команда
   - /prepare команда
   - Обработка естественных запросов

3. **Документация:**
   - API документация (Swagger)
   - Примеры использования
   - Troubleshooting guide

4. **Тесты:**
   - Unit тесты для controller
   - E2E тесты для основных сценариев

---

## Фаза C: Extract & React

**Цель:** Система проактивно извлекает события из переписки и предлагает действия.

**Продолжительность:** 2-3 недели

**Бизнес-ценность:** Пользователь не пропускает договорённости, обещания автоматически становятся напоминаниями.

### Неделя 3: Сущности и базовый pipeline

#### День 11-12: ExtractedEvent Entity

**Задача C1.1: Создание ExtractedEvent entity**

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

  // Источник
  @Column({ name: 'source_message_id', type: 'uuid' })
  @Index()
  sourceMessageId: string;

  @ManyToOne(() => Message, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'source_message_id' })
  sourceMessage: Message;

  @Column({ name: 'source_interaction_id', type: 'uuid', nullable: true })
  sourceInteractionId: string | null;

  // Тип и данные
  @Column({ name: 'event_type', type: 'varchar', length: 30 })
  eventType: ExtractedEventType;

  @Column({ name: 'extracted_data', type: 'jsonb' })
  extractedData: ExtractedEventData;

  // Confidence и статус
  @Column({ type: 'decimal', precision: 3, scale: 2 })
  confidence: number;  // 0.00 - 1.00

  @Column({ type: 'varchar', length: 20, default: ExtractedEventStatus.PENDING })
  status: ExtractedEventStatus;

  // Связь с результатом (если создан)
  @Column({ name: 'result_entity_type', type: 'varchar', length: 30, nullable: true })
  resultEntityType: 'EntityEvent' | 'EntityFact' | null;

  @Column({ name: 'result_entity_id', type: 'uuid', nullable: true })
  resultEntityId: string | null;

  // Уведомление
  @Column({ name: 'notification_sent_at', type: 'timestamp', nullable: true })
  notificationSentAt: Date | null;

  @Column({ name: 'user_response_at', type: 'timestamp', nullable: true })
  userResponseAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

// Типизация extractedData по типу события
interface MeetingData {
  datetime?: string;      // ISO datetime
  dateText?: string;      // Оригинальный текст ("завтра в 15:00")
  topic?: string;
  participants?: string[];
}

interface PromiseData {
  what: string;           // Что обещано
  deadline?: string;      // Когда
  deadlineText?: string;  // Оригинальный текст срока
}

interface FactData {
  factType: string;       // birthday, phone, email, etc.
  value: string;
  quote: string;          // Цитата из сообщения
}

type ExtractedEventData = MeetingData | PromiseData | FactData | Record<string, unknown>;
```

**Задача C1.2: Миграция базы данных**

```typescript
// apps/pkg-core/src/database/migrations/XXXXXX-create-extracted-events.ts

export class CreateExtractedEvents implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE extracted_event_type AS ENUM (
        'meeting', 'promise_by_me', 'promise_by_them', 'task', 'fact', 'cancellation'
      );
      
      CREATE TYPE extracted_event_status AS ENUM (
        'pending', 'confirmed', 'rejected', 'auto_processed', 'expired'
      );

      CREATE TABLE extracted_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        source_interaction_id UUID REFERENCES interactions(id) ON DELETE SET NULL,
        event_type extracted_event_type NOT NULL,
        extracted_data JSONB NOT NULL,
        confidence DECIMAL(3,2) NOT NULL,
        status extracted_event_status NOT NULL DEFAULT 'pending',
        result_entity_type VARCHAR(30),
        result_entity_id UUID,
        notification_sent_at TIMESTAMP,
        user_response_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_extracted_events_source ON extracted_events(source_message_id);
      CREATE INDEX idx_extracted_events_status ON extracted_events(status);
      CREATE INDEX idx_extracted_events_type ON extracted_events(event_type);
      CREATE INDEX idx_extracted_events_created ON extracted_events(created_at DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE extracted_events`);
    await queryRunner.query(`DROP TYPE extracted_event_status`);
    await queryRunner.query(`DROP TYPE extracted_event_type`);
  }
}
```

Acceptance Criteria:
- [ ] Entity создана и экспортирована из @pkg/entities
- [ ] Миграция применена без ошибок
- [ ] CRUD операции работают

#### День 13-15: Event Extraction Service

**Задача C1.3: EventExtractionService**

Сервис для извлечения событий из сообщений.

```typescript
// apps/pkg-core/src/modules/event-extraction/event-extraction.service.ts

@Injectable()
export class EventExtractionService {
  private readonly logger = new Logger(EventExtractionService.name);
  private readonly schema: object;

  constructor(
    @InjectRepository(ExtractedEvent)
    private extractedEventRepo: Repository<ExtractedEvent>,
    private claudeAgentService: ClaudeAgentService,
    private schemaLoader: SchemaLoaderService,
  ) {
    this.schema = this.schemaLoader.load('event-extraction', EVENT_EXTRACTION_SCHEMA);
  }

  /**
   * Extract events from a message
   */
  async extractFromMessage(message: Message, entityName: string): Promise<ExtractedEvent[]> {
    // Skip very short messages
    if (message.content.length < 20) {
      return [];
    }

    const prompt = this.buildExtractionPrompt(message.content, entityName);

    try {
      const { data } = await this.claudeAgentService.call<ExtractionResult>({
        mode: 'oneshot',
        taskType: 'event_extraction',
        prompt,
        schema: this.schema,
        model: 'haiku',  // Быстрая и дешёвая модель
        referenceType: 'message',
        referenceId: message.id,
      });

      const events: ExtractedEvent[] = [];

      for (const extracted of data.events) {
        if (extracted.confidence < 0.5) {
          continue;  // Игнорируем низкую уверенность
        }

        const event = this.extractedEventRepo.create({
          sourceMessageId: message.id,
          sourceInteractionId: message.interactionId,
          eventType: extracted.type,
          extractedData: extracted.data,
          confidence: extracted.confidence,
          status: ExtractedEventStatus.PENDING,
        });

        events.push(await this.extractedEventRepo.save(event));
      }

      this.logger.log(`Extracted ${events.length} events from message ${message.id}`);
      return events;
    } catch (error) {
      this.logger.error(`Event extraction failed for message ${message.id}`, error);
      return [];
    }
  }

  /**
   * Batch extraction for multiple messages
   */
  async extractFromMessages(messages: Array<{ message: Message; entityName: string }>): Promise<ExtractedEvent[]> {
    const results: ExtractedEvent[] = [];

    for (const { message, entityName } of messages) {
      const events = await this.extractFromMessage(message, entityName);
      results.push(...events);
    }

    return results;
  }

  private buildExtractionPrompt(content: string, entityName: string): string {
    return `Проанализируй сообщение и извлеки события.

Собеседник: ${entityName}
Сообщение: "${content}"

Извлеки:
1. **Встречи/созвоны** — упоминания о планируемых встречах с датой/временем
2. **Мои обещания** — если я (автор) обещаю что-то сделать
3. **Их обещания** — если собеседник обещает что-то сделать
4. **Задачи** — если меня о чём-то просят
5. **Факты** — личная информация (день рождения, телефон, email, должность)
6. **Отмены/переносы** — если что-то отменяется или переносится

Для каждого события укажи confidence (0.0-1.0) — насколько уверен в извлечении.`;
  }
}

// JSON Schema для structured output
const EVENT_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['meeting', 'promise_by_me', 'promise_by_them', 'task', 'fact', 'cancellation'],
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          data: { type: 'object' },
        },
        required: ['type', 'confidence', 'data'],
      },
    },
  },
  required: ['events'],
};
```

Acceptance Criteria:
- [ ] Сервис извлекает события из сообщений
- [ ] Confidence scoring работает
- [ ] События сохраняются в БД
- [ ] Batch processing работает

### Неделя 4: Processing Pipeline и уведомления

#### День 16-17: Message Processing Queue

**Задача C2.1: Интеграция с message processing**

Добавить извлечение событий в pipeline обработки сообщений.

```typescript
// apps/pkg-core/src/modules/message/message-processing.service.ts

@Injectable()
export class MessageProcessingService {
  constructor(
    @InjectQueue('message-processing')
    private processingQueue: Queue,
    private eventExtractionService: EventExtractionService,
    private embeddingService: EmbeddingService,
    private factExtractionService: FactExtractionService,
  ) {}

  /**
   * Queue message for background processing
   */
  async queueForProcessing(message: Message, entityId: string, entityName: string): Promise<void> {
    await this.processingQueue.add('process-message', {
      messageId: message.id,
      entityId,
      entityName,
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  /**
   * Process message (called by worker)
   */
  async processMessage(job: Job<MessageProcessingJobData>): Promise<void> {
    const { messageId, entityId, entityName } = job.data;

    const message = await this.messageRepo.findOne({ where: { id: messageId } });
    if (!message) return;

    // Parallel processing
    await Promise.all([
      // 1. Generate embedding for search
      this.embeddingService.generateForMessage(message),
      
      // 2. Extract facts (existing)
      this.factExtractionService.extractFacts({
        entityId,
        entityName,
        messageContent: message.content,
        messageId: message.id,
      }),
      
      // 3. Extract events (NEW)
      this.eventExtractionService.extractFromMessage(message, entityName),
    ]);
  }
}
```

**Задача C2.2: BullMQ Worker**

```typescript
// apps/pkg-core/src/modules/message/message-processing.processor.ts

@Processor('message-processing')
export class MessageProcessingProcessor {
  constructor(private processingService: MessageProcessingService) {}

  @Process('process-message')
  async handleProcessMessage(job: Job<MessageProcessingJobData>): Promise<void> {
    await this.processingService.processMessage(job);
  }
}
```

#### День 18-19: Notification Service

**Задача C2.3: NotificationService**

Сервис для отправки уведомлений о извлечённых событиях.

```typescript
// apps/pkg-core/src/modules/notification/notification.service.ts

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectRepository(ExtractedEvent)
    private extractedEventRepo: Repository<ExtractedEvent>,
    private telegramNotifier: TelegramNotifierService,
  ) {}

  /**
   * Send notification for extracted event
   */
  async notifyAboutEvent(event: ExtractedEvent): Promise<void> {
    const message = this.formatEventNotification(event);
    const buttons = this.getEventButtons(event);

    await this.telegramNotifier.sendWithButtons(message, buttons);

    // Mark as notified
    await this.extractedEventRepo.update(event.id, {
      notificationSentAt: new Date(),
    });
  }

  /**
   * Process pending events and send notifications based on priority
   */
  async processPendingEvents(): Promise<void> {
    const pending = await this.extractedEventRepo.find({
      where: {
        status: ExtractedEventStatus.PENDING,
        notificationSentAt: IsNull(),
      },
      order: { createdAt: 'ASC' },
      take: 10,
    });

    for (const event of pending) {
      const priority = this.calculatePriority(event);
      
      if (priority === 'high') {
        // Немедленное уведомление
        await this.notifyAboutEvent(event);
      } else if (priority === 'medium') {
        // Добавить в hourly digest
        await this.addToDigest(event, 'hourly');
      } else {
        // Добавить в daily digest
        await this.addToDigest(event, 'daily');
      }
    }
  }

  private calculatePriority(event: ExtractedEvent): 'high' | 'medium' | 'low' {
    // High priority:
    // - Meeting within 24 hours
    // - Cancellation/rescheduling
    // - High confidence (> 0.9)
    
    if (event.eventType === 'cancellation') return 'high';
    if (event.confidence > 0.9) {
      if (event.eventType === 'meeting') {
        const data = event.extractedData as MeetingData;
        if (data.datetime) {
          const meetingDate = new Date(data.datetime);
          const hoursUntil = (meetingDate.getTime() - Date.now()) / (1000 * 60 * 60);
          if (hoursUntil < 24) return 'high';
        }
      }
    }
    
    // Medium priority:
    // - Promise with deadline
    // - Task from contact
    if (event.eventType === 'task') return 'medium';
    if (['promise_by_me', 'promise_by_them'].includes(event.eventType)) {
      const data = event.extractedData as PromiseData;
      if (data.deadline) return 'medium';
    }
    
    return 'low';
  }

  private formatEventNotification(event: ExtractedEvent): string {
    switch (event.eventType) {
      case 'meeting':
        const meeting = event.extractedData as MeetingData;
        return `📅 **Договорились о встрече:**\n${meeting.topic || 'Созвон'}\n🕐 ${meeting.dateText || meeting.datetime}`;
      
      case 'promise_by_me':
        const myPromise = event.extractedData as PromiseData;
        return `📝 **Ты обещал:**\n${myPromise.what}\n${myPromise.deadlineText ? `⏰ ${myPromise.deadlineText}` : ''}`;
      
      case 'promise_by_them':
        const theirPromise = event.extractedData as PromiseData;
        return `👀 **Тебе обещали:**\n${theirPromise.what}\n${theirPromise.deadlineText ? `⏰ ${theirPromise.deadlineText}` : ''}`;
      
      case 'task':
        return `📋 **Тебя просят:**\n${(event.extractedData as { what: string }).what}`;
      
      case 'fact':
        const fact = event.extractedData as FactData;
        return `ℹ️ **Новый факт:**\n${fact.factType}: ${fact.value}`;
      
      case 'cancellation':
        return `❌ **Отмена/перенос:**\n${(event.extractedData as { what: string }).what}`;
      
      default:
        return `📌 **Событие:**\n${JSON.stringify(event.extractedData)}`;
    }
  }

  private getEventButtons(event: ExtractedEvent): InlineKeyboardButton[][] {
    const baseButtons = [
      { text: '✅ Подтвердить', callback_data: `event_confirm:${event.id}` },
      { text: '❌ Игнорировать', callback_data: `event_reject:${event.id}` },
    ];

    // Add type-specific buttons
    if (event.eventType === 'meeting') {
      return [
        baseButtons,
        [{ text: '⏰ Изменить время', callback_data: `event_reschedule:${event.id}` }],
      ];
    }

    if (['promise_by_me', 'task'].includes(event.eventType)) {
      return [
        baseButtons,
        [{ text: '🔔 Напомнить позже', callback_data: `event_remind:${event.id}` }],
      ];
    }

    return [baseButtons];
  }
}
```

#### День 20-21: Callback Handlers

**Задача C2.4: Обработка ответов пользователя**

```typescript
// apps/telegram-adapter/src/bot/handlers/event-callback.handler.ts

@Injectable()
export class EventCallbackHandler {
  constructor(
    private readonly httpService: HttpService,
  ) {}

  async handleCallback(ctx: Context, callbackData: string): Promise<void> {
    const [action, eventId] = callbackData.split(':');

    switch (action) {
      case 'event_confirm':
        await this.confirmEvent(ctx, eventId);
        break;
      case 'event_reject':
        await this.rejectEvent(ctx, eventId);
        break;
      case 'event_reschedule':
        await this.initiateReschedule(ctx, eventId);
        break;
      case 'event_remind':
        await this.setupReminder(ctx, eventId);
        break;
    }
  }

  private async confirmEvent(ctx: Context, eventId: string): Promise<void> {
    try {
      await this.httpService.post(`/extracted-events/${eventId}/confirm`).toPromise();
      await ctx.editMessageText('✅ Событие подтверждено и добавлено в календарь');
    } catch (error) {
      await ctx.answerCbQuery('Ошибка при подтверждении');
    }
  }

  private async rejectEvent(ctx: Context, eventId: string): Promise<void> {
    try {
      await this.httpService.post(`/extracted-events/${eventId}/reject`).toPromise();
      await ctx.editMessageText('❌ Событие отклонено');
    } catch (error) {
      await ctx.answerCbQuery('Ошибка');
    }
  }
}
```

**Задача C2.5: API endpoints для событий**

```typescript
// apps/pkg-core/src/modules/event-extraction/extracted-event.controller.ts

@Controller('extracted-events')
export class ExtractedEventController {
  constructor(
    private readonly extractedEventService: ExtractedEventService,
    private readonly entityEventService: EntityEventService,
  ) {}

  @Get()
  async list(@Query() query: ExtractedEventQueryDto) {
    return this.extractedEventService.findAll(query);
  }

  @Post(':id/confirm')
  async confirm(@Param('id', ParseUUIDPipe) id: string): Promise<{ success: boolean; createdEntityId?: string }> {
    const event = await this.extractedEventService.findById(id);
    if (!event) throw new NotFoundException();

    // Create corresponding entity based on event type
    const result = await this.createResultEntity(event);

    // Update extracted event status
    await this.extractedEventService.updateStatus(id, ExtractedEventStatus.CONFIRMED, result);

    return { success: true, createdEntityId: result.id };
  }

  @Post(':id/reject')
  async reject(@Param('id', ParseUUIDPipe) id: string): Promise<{ success: boolean }> {
    await this.extractedEventService.updateStatus(id, ExtractedEventStatus.REJECTED);
    return { success: true };
  }

  private async createResultEntity(event: ExtractedEvent): Promise<{ id: string; type: string }> {
    switch (event.eventType) {
      case 'meeting':
      case 'promise_by_me':
      case 'promise_by_them':
      case 'task': {
        const entityEvent = await this.entityEventService.create({
          entityId: /* get from source message */,
          eventType: this.mapToEntityEventType(event.eventType),
          title: this.extractTitle(event),
          eventDate: this.extractDate(event),
          sourceMessageId: event.sourceMessageId,
        });
        return { id: entityEvent.id, type: 'EntityEvent' };
      }
      
      case 'fact': {
        const data = event.extractedData as FactData;
        const fact = await this.entityFactService.create({
          entityId: /* get from source message */,
          factType: data.factType,
          value: data.value,
          sourceMessageId: event.sourceMessageId,
        });
        return { id: fact.id, type: 'EntityFact' };
      }
      
      default:
        throw new Error(`Unknown event type: ${event.eventType}`);
    }
  }
}
```

### Неделя 5: Scheduled Jobs и Digest

#### День 22-24: Scheduled Processing

**Задача C3.1: Cron jobs для обработки событий**

```typescript
// apps/pkg-core/src/modules/notification/notification-scheduler.service.ts

@Injectable()
export class NotificationSchedulerService {
  constructor(
    private notificationService: NotificationService,
    private digestService: DigestService,
  ) {}

  /**
   * Every 5 minutes: process high-priority pending events
   */
  @Cron('*/5 * * * *')
  async processHighPriorityEvents(): Promise<void> {
    await this.notificationService.processHighPriorityEvents();
  }

  /**
   * Every hour: send hourly digest
   */
  @Cron('0 * * * *')
  async sendHourlyDigest(): Promise<void> {
    await this.digestService.sendHourlyDigest();
  }

  /**
   * 21:00 Moscow: send daily digest
   */
  @Cron('0 21 * * *', { timeZone: 'Europe/Moscow' })
  async sendDailyDigest(): Promise<void> {
    await this.digestService.sendDailyDigest();
  }

  /**
   * 08:00 Moscow: morning brief
   */
  @Cron('0 8 * * *', { timeZone: 'Europe/Moscow' })
  async sendMorningBrief(): Promise<void> {
    await this.digestService.sendMorningBrief();
  }

  /**
   * Expire old pending events (older than 7 days)
   */
  @Cron('0 3 * * *')
  async expireOldEvents(): Promise<void> {
    await this.notificationService.expireOldPendingEvents();
  }
}
```

**Задача C3.2: DigestService**

```typescript
// apps/pkg-core/src/modules/notification/digest.service.ts

@Injectable()
export class DigestService {
  async sendMorningBrief(): Promise<void> {
    // Собрать:
    // 1. Встречи на сегодня
    // 2. Дедлайны на сегодня
    // 3. Дни рождения сегодня
    // 4. Просроченные обещания
    // 5. Ожидаемые ответы

    const today = new Date();
    
    const [meetings, deadlines, birthdays, overduePromises, pendingFollowups] = await Promise.all([
      this.entityEventService.getByDate(today, 'meeting'),
      this.entityEventService.getByDate(today, 'deadline'),
      this.entityService.getByBirthday(today),
      this.entityEventService.getOverdue('commitment'),
      this.entityEventService.getOverdue('follow_up'),
    ]);

    const message = this.formatMorningBrief({
      meetings,
      deadlines,
      birthdays,
      overduePromises,
      pendingFollowups,
    });

    await this.telegramNotifier.send(message);
  }

  async sendHourlyDigest(): Promise<void> {
    const events = await this.extractedEventRepo.find({
      where: {
        status: ExtractedEventStatus.PENDING,
        notificationSentAt: IsNull(),
        // priority: 'medium' — через metadata или calculated
      },
      order: { createdAt: 'ASC' },
    });

    if (events.length === 0) return;

    const message = this.formatHourlyDigest(events);
    await this.telegramNotifier.sendWithButtons(message, this.getDigestButtons(events));

    // Mark all as notified
    await this.extractedEventRepo.update(
      events.map(e => e.id),
      { notificationSentAt: new Date() },
    );
  }

  private formatMorningBrief(data: MorningBriefData): string {
    let msg = '🌅 **Доброе утро! Вот твой день:**\n\n';

    if (data.meetings.length > 0) {
      msg += '📅 **Встречи:**\n';
      data.meetings.forEach(m => {
        msg += `• ${m.eventDate?.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} — ${m.title}\n`;
      });
      msg += '\n';
    }

    if (data.birthdays.length > 0) {
      msg += '🎂 **Дни рождения:**\n';
      data.birthdays.forEach(b => {
        msg += `• ${b.name}\n`;
      });
      msg += '\n';
    }

    if (data.overduePromises.length > 0) {
      msg += '⚠️ **Просроченные обещания:**\n';
      data.overduePromises.forEach(p => {
        msg += `• ${p.title} (${this.daysOverdue(p.eventDate)} дн.)\n`;
      });
      msg += '\n';
    }

    if (data.pendingFollowups.length > 0) {
      msg += '👀 **Ждёшь ответа:**\n';
      data.pendingFollowups.forEach(f => {
        msg += `• ${f.title} от ${f.entity?.name}\n`;
      });
    }

    return msg || '🌅 Сегодня ничего запланированного. Хорошего дня!';
  }
}
```

### Deliverables фазы C

1. **Database:**
   - ExtractedEvent entity и миграция

2. **Services:**
   - EventExtractionService — извлечение событий из сообщений
   - NotificationService — отправка уведомлений
   - DigestService — morning brief, hourly/daily digests

3. **API:**
   - GET /extracted-events
   - POST /extracted-events/:id/confirm
   - POST /extracted-events/:id/reject

4. **Telegram:**
   - Callback handlers для кнопок
   - Morning brief
   - Hourly/daily digests

5. **Scheduled Jobs:**
   - High-priority event processing (every 5 min)
   - Hourly digest
   - Daily digest (21:00)
   - Morning brief (08:00)

---

## Фаза A: Act Capabilities

**Цель:** Система может выполнять действия (отправка сообщений) с подтверждением пользователя.

**Продолжительность:** 1-2 недели

**Бизнес-ценность:** Пользователь может попросить "напиши Сергею что встреча переносится" и система подготовит и отправит сообщение.

### Неделя 6-7: Action Tools и Approval

#### День 25-26: ActionToolsProvider

**Задача A1.1: Создание ActionToolsProvider**

```typescript
// apps/pkg-core/src/modules/claude-agent/tools/action-tools.provider.ts

@Injectable()
export class ActionToolsProvider {
  private readonly logger = new Logger(ActionToolsProvider.name);
  private cachedTools: ToolDefinition[] | null = null;

  constructor(
    private readonly telegramService: TelegramSendService,
    private readonly entityEventService: EntityEventService,
    private readonly entityService: EntityService,
  ) {}

  getTools(): ToolDefinition[] {
    if (!this.cachedTools) {
      this.cachedTools = this.createTools();
    }
    return this.cachedTools;
  }

  private createTools() {
    return [
      tool(
        'draft_message',
        `Create a draft message for a contact WITHOUT sending it.
Use this to show the user what message will be sent before getting approval.
Returns the draft text that can be edited or approved.`,
        {
          entityId: z.string().uuid().describe('ID of the recipient'),
          intent: z.string().describe('What the message should communicate (e.g., "reschedule meeting to tomorrow")'),
          tone: z.enum(['formal', 'casual', 'friendly']).default('friendly').describe('Desired tone'),
        },
        async (args) => {
          try {
            const entity = await this.entityService.findOne(args.entityId);
            if (!entity) {
              return toolError(`Entity ${args.entityId} not found`);
            }

            // Get recent context for personalization
            const context = await this.getRecentContext(args.entityId);

            const draft = await this.generateDraft(entity.name, args.intent, args.tone, context);

            return toolSuccess({
              draft,
              recipient: entity.name,
              note: 'This is a draft. Ask user to confirm before sending with send_telegram.',
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'draft_message');
          }
        }
      ),

      tool(
        'send_telegram',
        `Send a Telegram message to a contact.
⚠️ REQUIRES USER APPROVAL before sending.
Always use draft_message first to show the user what will be sent.`,
        {
          entityId: z.string().uuid().describe('ID of the recipient'),
          text: z.string().min(1).max(4096).describe('Message text to send'),
        },
        async (args) => {
          try {
            // This will be intercepted by approval hook
            await this.telegramService.sendToEntity(args.entityId, args.text);
            
            return toolSuccess({
              sent: true,
              message: 'Message sent successfully',
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'send_telegram');
          }
        }
      ),

      tool(
        'schedule_followup',
        `Schedule a follow-up reminder for a contact.
Use after sending a message to remind yourself to check for response.`,
        {
          entityId: z.string().uuid().describe('ID of the contact'),
          reason: z.string().describe('What to follow up about'),
          checkAfter: z.string().describe('When to check (ISO datetime or relative like "in 2 days")'),
        },
        async (args) => {
          try {
            const checkDate = parseDate(args.checkAfter);
            
            const event = await this.entityEventService.create({
              entityId: args.entityId,
              eventType: EventType.FOLLOW_UP,
              title: `Follow up: ${args.reason}`,
              eventDate: checkDate,
            });

            return toolSuccess({
              created: true,
              id: event.id,
              checkDate: checkDate.toISOString(),
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'schedule_followup');
          }
        }
      ),
    ] as ToolDefinition[];
  }

  private async generateDraft(
    recipientName: string,
    intent: string,
    tone: string,
    context: string,
  ): Promise<string> {
    // Simple template-based generation
    // Could be enhanced with LLM call for more natural messages
    
    const greetings = {
      formal: 'Добрый день',
      casual: 'Привет',
      friendly: 'Привет',
    };

    return `${greetings[tone]}, ${recipientName.split(' ')[0]}! ${intent}`;
  }
}
```

#### День 27-28: Approval Hooks

**Задача A1.2: Реализация Approval Hook**

```typescript
// apps/pkg-core/src/modules/claude-agent/hooks/approval.hook.ts

export interface ApprovalRequest {
  eventId: string;
  action: string;
  title: string;
  details: string;
  entityName: string;
}

export interface ApprovalResult {
  approved: boolean;
  modifiedInput?: Record<string, unknown>;
  reason?: string;
}

@Injectable()
export class ApprovalHookService {
  private readonly pendingApprovals = new Map<string, {
    resolve: (result: ApprovalResult) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(
    private readonly telegramNotifier: TelegramNotifierService,
    private readonly entityService: EntityService,
  ) {}

  /**
   * Create approval hook for agent
   */
  createHook(): AgentHooks {
    return {
      onToolUse: async (toolName: string, input: unknown) => {
        if (toolName === 'send_telegram') {
          return this.requestApproval(toolName, input as { entityId: string; text: string });
        }
        return { approve: true };
      },
    };
  }

  /**
   * Request user approval for action
   */
  async requestApproval(
    action: string,
    input: { entityId: string; text: string },
  ): Promise<{ approve: boolean; reason?: string }> {
    const entity = await this.entityService.findOne(input.entityId);
    const eventId = randomUUID();

    const message = `📤 **Отправить сообщение?**

**Кому:** ${entity?.name || input.entityId}

**Текст:**
${input.text}`;

    const buttons = [
      [
        { text: '✅ Отправить', callback_data: `approve:${eventId}` },
        { text: '❌ Отмена', callback_data: `reject:${eventId}` },
      ],
      [
        { text: '✏️ Редактировать', callback_data: `edit:${eventId}` },
      ],
    ];

    await this.telegramNotifier.sendWithButtons(message, buttons);

    // Wait for user response with timeout
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(eventId);
        resolve({ approve: false, reason: 'Timeout waiting for approval' });
      }, 120000); // 2 minutes

      this.pendingApprovals.set(eventId, { resolve, timeout });
    });
  }

  /**
   * Handle user response from Telegram callback
   */
  handleApprovalResponse(eventId: string, approved: boolean, modifiedText?: string): void {
    const pending = this.pendingApprovals.get(eventId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingApprovals.delete(eventId);

    pending.resolve({
      approved,
      modifiedInput: modifiedText ? { text: modifiedText } : undefined,
    });
  }
}
```

**Задача A1.3: Telegram Send Service**

```typescript
// apps/pkg-core/src/modules/telegram/telegram-send.service.ts

@Injectable()
export class TelegramSendService {
  constructor(
    private readonly httpService: HttpService,  // To call telegram-adapter
    private readonly entityService: EntityService,
  ) {}

  /**
   * Send message to entity via Telegram
   */
  async sendToEntity(entityId: string, text: string): Promise<void> {
    // Find Telegram identifier for entity
    const entity = await this.entityService.findOne(entityId);
    const telegramId = entity?.identifiers?.find(i => i.identifierType === 'telegram');

    if (!telegramId) {
      throw new Error(`Entity ${entityId} has no Telegram identifier`);
    }

    // Call telegram-adapter to send
    await this.httpService.post('/telegram/send', {
      chatId: telegramId.identifierValue,
      text,
    }).toPromise();
  }
}
```

#### День 29-30: Act Endpoint

**Задача A1.4: Act API Endpoint**

```typescript
// apps/pkg-core/src/modules/claude-agent/claude-agent.controller.ts

@Post('act')
async act(@Body() dto: ActRequestDto): Promise<ActResponseDto> {
  const mcpServer = this.toolsRegistry.createMcpServer(['entities', 'events', 'actions']);
  const approvalHook = this.approvalHookService.createHook();

  const { data, usage, toolsUsed } = await this.agentService.call<ActResult>({
    mode: 'agent',
    taskType: 'action',
    prompt: this.buildActPrompt(dto.instruction),
    toolCategories: ['entities', 'events', 'actions'],
    hooks: approvalHook,
    maxTurns: 10,
  });

  return {
    result: data,
    actions: this.extractActions(toolsUsed),
    usage,
  };
}

private buildActPrompt(instruction: string): string {
  return `Выполни действие по инструкции пользователя: "${instruction}"

Порядок действий:
1. Найди нужного контакта (find_entity или list_entities)
2. Создай черновик сообщения (draft_message) и покажи его пользователю
3. Дождись подтверждения и отправь (send_telegram)
4. При необходимости создай follow-up напоминание (schedule_followup)

ВАЖНО: Всегда показывай пользователю что будет отправлено ПЕРЕД отправкой.`;
}
```

**Задача A1.5: Telegram Bot Handler для Act**

```typescript
// apps/telegram-adapter/src/bot/handlers/agent.handler.ts

/**
 * Handle /act command or natural action requests
 * Examples:
 *   /act напиши Сергею что встреча переносится
 *   напомни Маше про документы
 */
async handleAct(ctx: Context, instruction: string): Promise<void> {
  await ctx.reply('🤖 Обрабатываю запрос...');

  try {
    const response = await this.httpService.post('/agent/act', { instruction }).toPromise();
    const { result, actions } = response.data;

    // Result message is sent through approval flow
    // Just confirm completion here
    if (actions.some(a => a.type === 'message_sent')) {
      await ctx.reply('✅ Действие выполнено');
    } else {
      await ctx.reply(`📋 Результат: ${result}`);
    }
  } catch (error) {
    await ctx.reply('❌ Не удалось выполнить действие');
  }
}
```

### Deliverables фазы A

1. **Tools:**
   - ActionToolsProvider с draft_message, send_telegram, schedule_followup

2. **Hooks:**
   - ApprovalHookService — запрос подтверждения через Telegram

3. **Services:**
   - TelegramSendService — отправка сообщений

4. **API:**
   - POST /agent/act — выполнение действий

5. **Telegram:**
   - /act команда
   - Approval callbacks (approve, reject, edit)
   - Natural language action detection

---

## Timeline Summary

```
Week 1: Phase B - API и базовая интеграция
  Day 1: Верификация миграции
  Day 2-3: Recall endpoint
  Day 4-5: Prepare endpoint

Week 2: Phase B - Telegram интеграция
  Day 6-7: Telegram bot handlers
  Day 8-10: Testing и polish

Week 3: Phase C - Сущности и extraction
  Day 11-12: ExtractedEvent entity
  Day 13-15: EventExtractionService

Week 4: Phase C - Notifications
  Day 16-17: Message processing pipeline
  Day 18-19: NotificationService
  Day 20-21: Callback handlers

Week 5: Phase C - Scheduled jobs
  Day 22-24: Cron jobs и DigestService

Week 6-7: Phase A - Act capabilities
  Day 25-26: ActionToolsProvider
  Day 27-28: Approval hooks
  Day 29-30: Act endpoint и integration
```

---

## Success Metrics

### Phase B (Recall/Prepare)
- Recall отвечает на 80%+ запросов с релевантными источниками
- Prepare генерирует полезный brief за < 30 секунд
- Пользователь использует /recall минимум 5 раз в неделю

### Phase C (Extract & React)
- 85%+ извлечённых событий корректны (по оценке пользователя)
- < 5% false positives (лишние уведомления)
- Morning brief отправляется каждый день в 08:00

### Phase A (Act)
- 100% сообщений проходят через approval
- 0 случаев отправки без подтверждения
- Среднее время от запроса до отправки < 60 секунд

---

## Risk Mitigation

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| LLM rate limits | Средняя | Batch processing, caching, fallback на haiku |
| Некорректное извлечение | Средняя | Confidence thresholds, user confirmation |
| Spam уведомлениями | Средняя | Digests, quiet hours, priority filtering |
| Неавторизованная отправка | Низкая | Mandatory approval hook, audit log |
| Telegram API limits | Низкая | Rate limiting, queue |

---

## Next Steps After Completion

После завершения всех трёх фаз можно развивать:

1. **Web Dashboard** — управление напоминаниями, просмотр извлечённых событий
2. **Voice Interface** — голосовые команды через Telegram voice messages
3. **Calendar Integration** — синхронизация с Google Calendar
4. **Multi-user** — поддержка нескольких пользователей
5. **Analytics** — статистика общения, паттерны коммуникации
