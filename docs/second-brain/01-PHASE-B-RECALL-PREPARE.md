# Фаза B: Пилот Recall/Prepare

**Цель:** Получить работающий продукт для поиска информации и подготовки к встречам.

**Продолжительность:** 1.5-2 недели

**Бизнес-ценность:** Пользователь может задать вопрос "кто мне советовал юриста?" или "подготовь brief к встрече с Петром" и получить релевантный ответ.

---

## Неделя 1: API и базовая интеграция

### Задача B1.2: AgentController ✅

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

**Acceptance Criteria:**
- [x] Контроллер создан и зарегистрирован в модуле
- [x] DTO классы определены с валидацией
- [ ] Swagger документация генерируется

---

### Задача B1.3: Recall API ✅

#### DTOs

```typescript
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

#### Implementation

```typescript
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

**Acceptance Criteria:**
- [x] POST /agent/recall принимает запросы
- [x] Агент выполняет итеративный поиск (видно в логах tool calls)
- [x] Ответ содержит текст и источники
- [ ] Работает фильтрация по entityId
- [x] Timeout корректно обрабатывается

---

### Задача B1.5: Prepare API ✅

#### DTOs

```typescript
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

**Acceptance Criteria:**
- [x] POST /agent/prepare/:entityId работает
- [x] Brief содержит все секции (summary, facts, topics, etc.)
- [x] Агент использует несколько tools для сбора информации
- [ ] Context влияет на suggestedTopics

---

## Неделя 2: Telegram интеграция

### Задача B2.1: Telegram Bot Handler ✅

```typescript
// apps/telegram-adapter/src/bot/handlers/agent.handler.ts

@Injectable()
export class AgentHandler {
  constructor(
    private readonly httpService: HttpService,
  ) {}

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

  async handlePrepare(ctx: Context, entityNameOrId: string): Promise<void> {
    await ctx.reply('📝 Готовлю brief...');
    // ... implementation
  }
}
```

**Acceptance Criteria:**
- [x] /recall команда работает
- [x] /prepare команда работает
- [ ] Естественные запросы распознаются
- [x] Форматирование Markdown корректное
- [x] Ошибки обрабатываются gracefully

---

## Тест-кейсы

### Recall

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

### Prepare

1. **Brief для активного контакта** — богатый brief с recent topics
2. **Brief для давнего контакта** — акцент на "давно не общались"
3. **Brief с контекстом** — suggestedTopics релевантны контексту

---

## Deliverables

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

4. **Тесты:**
   - Unit тесты для controller
   - E2E тесты для основных сценариев
