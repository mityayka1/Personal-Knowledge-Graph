# Задача: Миграция на Claude Agent SDK

> Замена ClaudeCliService (spawn) на ClaudeAgentService (Agent SDK) для поддержки агентных сценариев.

## 1. Контекст и мотивация

### 1.1 Текущее состояние

**ClaudeCliService** — сервис для вызова Claude CLI через spawn:

```typescript
// apps/pkg-core/src/modules/claude-cli/claude-cli.service.ts
async call<T>(params: ClaudeCliCallParams<T>): Promise<ClaudeCliResult<T>>
```

**Как работает:**
1. Формирует аргументы: `--print --model X --output-format json --json-schema '{...}' -p "prompt"`
2. Spawn процесса с `stdio: ['ignore', 'pipe', 'pipe']`
3. Парсит JSON, извлекает `structured_output`
4. Логирует в `claude_cli_runs`

**Где используется (4 места):**

| Сервис | taskType | Файл |
|--------|----------|------|
| `SummarizationService` | `summarization` | `summarization.service.ts` |
| `EntityProfileService` | `profile_aggregation` | `entity-profile.service.ts` |
| `ContextService` | `context_synthesis` | `context.service.ts` |
| `FactExtractionService` | `fact_extraction` | `fact-extraction.service.ts` (свой spawn) |

### 1.2 Зачем нужен Agent SDK

**Ограничения spawn:**
- Только one-shot (prompt → response)
- Нет tools, нет agent loop, нет hooks

**Что даёт Agent SDK:**

| Возможность | Spawn | Agent SDK |
|-------------|-------|-----------|
| One-shot вызовы | ✅ | ✅ |
| Structured output | ✅ | ✅ |
| Agent loop (multi-turn) | ❌ | ✅ |
| Tools как функции | ❌ | ✅ |
| Hooks (approval, logging) | ❌ | ✅ |
| Budget control | ❌ | ✅ |

**Новые сценарии:**
- **Recall Agent** — итеративный поиск
- **Prepare Agent** — multi-step сбор контекста
- **Act Agent** — действия с approval hooks

### 1.3 Авторизация: Подписка vs API ключ

> **Важно:** Claude Agent SDK работает с подпиской (Pro/Max/Team), API ключ НЕ требуется!

Agent SDK использует Claude Code CLI под капотом, поэтому наследует все способы авторизации CLI:

| Способ авторизации | Поддержка |
|-------------------|-----------|
| Подписка Pro/Max/Team (`claude login`) | ✅ |
| API ключ (`ANTHROPIC_API_KEY`) | ✅ |

**Проверено:**
```bash
# Без API ключа, только с подпиской
unset ANTHROPIC_API_KEY
npx ts-node test-agent.ts
# ✅ Test passed - Agent SDK works with subscription!
```

**Преимущества работы по подписке:**
- Фиксированная стоимость (Max $100-200/мес)
- Нет неожиданных счетов за API
- Общие лимиты с claude.ai и Claude Code CLI
- Сброс лимитов каждые 5 часов

**Когда нужен API ключ:**
- CI/CD pipelines (headless)
- Docker без mount credentials
- Нужен 1M token context (vs 200K у подписки)

---

## 2. Решение

### 2.1 Подход: полная замена, без facade

**Почему:**
- Внутренний API, нет внешних потребителей
- Всего 4 места использования
- Facade создаёт техдолг
- Миграция 4 мест — 30 минут работы

**Итог:** Удаляем `ClaudeCliService`, создаём `ClaudeAgentService`, мигрируем всё сразу.

### 2.2 Структура модуля

```
apps/pkg-core/src/modules/claude-agent/
├── claude-agent.module.ts
├── claude-agent.service.ts      # Основной сервис
├── claude-agent.types.ts        # Типы
├── schema-loader.service.ts     # Перенос из claude-cli
├── tools/
│   ├── index.ts
│   ├── search.tools.ts          # search_messages, get_message_context
│   ├── entity.tools.ts          # get_entity, find_entity, get_interactions, get_open_items
│   ├── context.tools.ts         # get_context
│   └── action.tools.ts          # send_telegram, create_reminder
└── hooks/
    ├── index.ts
    ├── approval.hook.ts
    └── logging.hook.ts
```

**Удаляем:**
```
apps/pkg-core/src/modules/claude-cli/  # Весь модуль
```

### 2.3 ClaudeAgentService

```typescript
// claude-agent.types.ts

export type TaskType =
  | 'summarization'
  | 'profile_aggregation'
  | 'context_synthesis'
  | 'fact_extraction'
  | 'recall'
  | 'meeting_prep'
  | 'daily_brief'
  | 'action';

export type ModelType = 'sonnet' | 'haiku' | 'opus';

interface BaseParams {
  taskType: TaskType;
  prompt: string;
  model?: ModelType;
  referenceType?: 'interaction' | 'entity' | 'message';
  referenceId?: string;
  timeout?: number;
}

export interface OneshotParams<T> extends BaseParams {
  mode: 'oneshot';
  schema: object;
}

export interface AgentParams extends BaseParams {
  mode: 'agent';
  tools?: ToolDefinition[];
  hooks?: AgentHooks;
  maxTurns?: number;
  budgetUsd?: number;
}

export type CallParams<T> = OneshotParams<T> | AgentParams;

export interface CallResult<T> {
  data: T;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
  };
  turns?: number;
  toolsUsed?: string[];
  run: ClaudeAgentRun;
}
```

```typescript
// claude-agent.service.ts

import { query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

@Injectable()
export class ClaudeAgentService {
  private readonly logger = new Logger(ClaudeAgentService.name);

  constructor(
    private configService: ConfigService,
    @InjectRepository(ClaudeAgentRun)
    private runRepo: Repository<ClaudeAgentRun>,
  ) {}

  /**
   * Универсальный метод вызова
   */
  async call<T>(params: CallParams<T>): Promise<CallResult<T>> {
    const startTime = Date.now();
    
    try {
      const result = params.mode === 'oneshot'
        ? await this.executeOneshot<T>(params)
        : await this.executeAgent<T>(params);
      
      const run = await this.logRun(params, result, Date.now() - startTime);
      return { ...result, run };
      
    } catch (error) {
      await this.logError(params, error, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * One-shot: structured output
   */
  private async executeOneshot<T>(params: OneshotParams<T>): Promise<Omit<CallResult<T>, 'run'>> {
    const model = this.getModelString(params.model);
    let result: T | undefined;
    let usage = { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
    
    for await (const message of query({
      prompt: params.prompt,
      options: {
        model,
        maxTurns: 1,
        systemPrompt: this.buildOneshotSystemPrompt(params.schema),
      }
    })) {
      if (message.type === 'usage') {
        usage.inputTokens += message.inputTokens || 0;
        usage.outputTokens += message.outputTokens || 0;
        usage.totalCostUsd += message.costUsd || 0;
      }
      
      if (message.type === 'result') {
        result = this.parseStructuredOutput<T>(message.result, params.schema);
      }
    }
    
    if (!result) throw new Error('No result from Claude');
    return { data: result, usage };
  }

  /**
   * Agent: tools + multi-turn
   */
  private async executeAgent<T>(params: AgentParams): Promise<Omit<CallResult<T>, 'run'>> {
    const model = this.getModelString(params.model);
    const toolsUsed: string[] = [];
    let turns = 0;
    let usage = { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
    let result: T | undefined;
    
    for await (const message of query({
      prompt: params.prompt,
      options: {
        model,
        maxTurns: params.maxTurns || 15,
        budgetUsd: params.budgetUsd || 0.50,
        systemPrompt: this.buildAgentSystemPrompt(params.taskType),
        tools: params.tools || [],
        ...(params.hooks || {}),
      }
    })) {
      if (message.type === 'turn') turns++;
      if (message.type === 'tool_use') toolsUsed.push(message.toolName);
      if (message.type === 'usage') {
        usage.inputTokens += message.inputTokens || 0;
        usage.outputTokens += message.outputTokens || 0;
        usage.totalCostUsd += message.costUsd || 0;
      }
      if (message.type === 'result') {
        result = message.result as T;
      }
    }
    
    if (!result) throw new Error('Agent finished without result');
    return { data: result, usage, turns, toolsUsed: [...new Set(toolsUsed)] };
  }

  private getModelString(model?: ModelType): string {
    const map = {
      'haiku': 'claude-haiku-4-5-20251001',
      'sonnet': 'claude-sonnet-4-5-20250514',
      'opus': 'claude-opus-4-5-20251101',
    };
    return map[model || 'sonnet'];
  }

  private buildOneshotSystemPrompt(schema: object): string {
    return `Respond ONLY with valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`;
  }

  private buildAgentSystemPrompt(taskType: TaskType): string {
    const prompts: Record<string, string> = {
      recall: 'Help find information from past conversations. Use search tools, try different phrasings.',
      meeting_prep: 'Prepare briefings for meetings. Gather context about people and open items.',
      daily_brief: 'Create daily summaries. Check meetings, reminders, pending items.',
      action: 'Help take actions like sending messages. Always confirm details before acting.',
    };
    return prompts[taskType] || '';
  }

  private parseStructuredOutput<T>(result: string, schema: object): T {
    try {
      return JSON.parse(result) as T;
    } catch {
      const match = result.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) return JSON.parse(match[1]) as T;
      throw new Error(`Failed to parse: ${result.slice(0, 200)}`);
    }
  }

  private async logRun(params: CallParams<unknown>, result: Omit<CallResult<unknown>, 'run'>, durationMs: number): Promise<ClaudeAgentRun> {
    const run = this.runRepo.create({
      taskType: params.taskType,
      mode: params.mode,
      model: this.getModelString(params.model),
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      costUsd: result.usage.totalCostUsd,
      durationMs,
      turnsCount: result.turns || 1,
      toolsUsed: result.toolsUsed || null,
      success: true,
      referenceType: params.referenceType || null,
      referenceId: params.referenceId || null,
      inputPreview: params.prompt.slice(0, 500),
      outputPreview: JSON.stringify(result.data).slice(0, 500),
      createdDate: new Date(),
    });
    return this.runRepo.save(run);
  }

  private async logError(params: CallParams<unknown>, error: unknown, durationMs: number): Promise<void> {
    const run = this.runRepo.create({
      taskType: params.taskType,
      mode: params.mode,
      model: this.getModelString(params.model),
      durationMs,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
      referenceType: params.referenceType || null,
      referenceId: params.referenceId || null,
      inputPreview: params.prompt.slice(0, 500),
      createdDate: new Date(),
    });
    await this.runRepo.save(run);
  }
}
```

### 2.4 PKG Tools

```typescript
// tools/search.tools.ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const createSearchTools = (searchService: SearchService) => [
  tool(
    'search_messages',
    'Semantic search through messages. Try different phrasings if no results.',
    {
      query: z.string().describe('Search query'),
      entityId: z.string().uuid().optional().describe('Filter by person/org'),
      limit: z.number().min(1).max(50).default(10),
    },
    async ({ query, entityId, limit }) => {
      const results = await searchService.search({ query, entityId, searchType: 'hybrid', limit });
      if (results.results.length === 0) return 'No results. Try different keywords.';
      return JSON.stringify(results.results.map(r => ({
        id: r.id, content: r.content, timestamp: r.timestamp, entityName: r.entity?.name,
      })));
    }
  ),

  tool(
    'get_message_context',
    'Get surrounding messages for context.',
    { messageId: z.string().uuid(), windowSize: z.number().default(5) },
    async ({ messageId, windowSize }) => {
      const context = await searchService.getMessageContext(messageId, windowSize);
      return JSON.stringify(context);
    }
  ),
];
```

```typescript
// tools/entity.tools.ts
export const createEntityTools = (entityService: EntityService, interactionService: InteractionService, openItemService: OpenItemService) => [
  tool(
    'get_entity',
    'Get full entity info: facts, profile, stats.',
    { entityId: z.string().uuid() },
    async ({ entityId }) => {
      const entity = await entityService.findOneWithProfile(entityId);
      return JSON.stringify({
        id: entity.id, name: entity.name, type: entity.type,
        organization: entity.organization?.name,
        facts: entity.facts.map(f => ({ type: f.factType, value: f.value })),
        profile: entity.relationshipProfile,
      });
    }
  ),

  tool(
    'find_entity',
    'Find entity by name or identifier.',
    { query: z.string() },
    async ({ query }) => {
      const entities = await entityService.search(query, 5);
      return JSON.stringify(entities.map(e => ({ id: e.id, name: e.name, type: e.type })));
    }
  ),

  tool(
    'get_interactions',
    'Get recent interactions with entity.',
    { entityId: z.string().uuid(), limit: z.number().default(5), includeSummary: z.boolean().default(true) },
    async ({ entityId, limit, includeSummary }) => {
      const interactions = await interactionService.findByEntity(entityId, { limit, includeSummary });
      return JSON.stringify(interactions);
    }
  ),

  tool(
    'get_open_items',
    'Get open promises, tasks, pending questions.',
    { entityId: z.string().uuid().optional(), type: z.enum(['all', 'promise_by_me', 'waiting_for', 'task']).default('all') },
    async ({ entityId, type }) => {
      const items = await openItemService.find({ entityId, type });
      return JSON.stringify(items);
    }
  ),
];
```

```typescript
// tools/action.tools.ts
export const createActionTools = (telegramService: TelegramService, reminderService: ReminderService) => [
  tool(
    'send_telegram',
    'Send Telegram message. REQUIRES USER APPROVAL.',
    { entityId: z.string().uuid(), text: z.string() },
    async ({ entityId, text }) => {
      await telegramService.sendToEntity(entityId, text);
      return 'Message sent';
    }
  ),

  tool(
    'create_reminder',
    'Create a reminder.',
    { text: z.string(), triggerAt: z.string(), entityId: z.string().uuid().optional() },
    async ({ text, triggerAt, entityId }) => {
      const reminder = await reminderService.create({ text, triggerAt: new Date(triggerAt), entityId, source: 'agent' });
      return `Reminder created: ${reminder.id}`;
    }
  ),
];
```

### 2.5 Hooks

```typescript
// hooks/approval.hook.ts
import { HookMatcher } from '@anthropic-ai/claude-agent-sdk';

export const createApprovalHook = (notificationService: NotificationService, entityService: EntityService) => ({
  PreToolUse: [
    HookMatcher({
      toolNames: ['send_telegram'],
      handler: async (toolUse) => {
        const { entityId, text } = toolUse.input as { entityId: string; text: string };
        const entity = await entityService.findOne(entityId);
        
        const approved = await notificationService.requestApproval({
          action: 'send_message',
          title: `Send to ${entity.name}?`,
          details: text,
          timeout: 120000,
        });
        
        return approved ? { decision: 'approve' } : { decision: 'block', message: 'User declined' };
      },
    }),
  ],
});
```

```typescript
// hooks/logging.hook.ts
export const createLoggingHook = (logger: Logger) => ({
  PostToolUse: [
    HookMatcher({
      toolNames: ['*'],
      handler: async (toolUse, result) => {
        logger.log({ tool: toolUse.name, success: result.type === 'success', duration: result.durationMs });
        return {};
      },
    }),
  ],
});
```

### 2.6 Миграция БД

```sql
-- Переименование таблицы
ALTER TABLE claude_cli_runs RENAME TO claude_agent_runs;

-- Новые колонки
ALTER TABLE claude_agent_runs 
ADD COLUMN mode VARCHAR(20) DEFAULT 'oneshot',
ADD COLUMN turns_count INT DEFAULT 1,
ADD COLUMN tools_used JSONB;

-- Обновить существующие записи
UPDATE claude_agent_runs SET mode = 'oneshot', turns_count = 1;
```

---

## 3. Миграция существующих сервисов

### Изменения минимальны — только параметры вызова:

```typescript
// ДО (все 4 сервиса)
const { data } = await this.claudeCliService.call<ResultType>({
  taskType: 'summarization',
  agentName: 'summarizer',
  prompt,
  schema: this.schema,
  model: 'sonnet',
  referenceType: 'interaction',
  referenceId: interactionId,
});

// ПОСЛЕ
const { data } = await this.claudeAgentService.call<ResultType>({
  mode: 'oneshot',  // 🆕 добавить
  taskType: 'summarization',
  // agentName удалён
  prompt,
  schema: this.schema,
  model: 'sonnet',
  referenceType: 'interaction',
  referenceId: interactionId,
});
```

**FactExtractionService** — удалить собственный spawn, использовать общий сервис.

---

## 4. План реализации

### Phase 1: Инфраструктура + Миграция (4-5 дней)

- [ ] `pnpm add @anthropic-ai/claude-agent-sdk zod`
- [ ] Создать `claude-agent/` модуль со структурой
- [ ] `ClaudeAgentService` с `mode: 'oneshot'`
- [ ] Миграция БД
- [ ] Мигрировать 4 сервиса (SummarizationService, EntityProfileService, ContextService, FactExtractionService)
- [ ] Удалить `claude-cli/` модуль
- [ ] Unit тесты

**DoD:** Все существующие задачи работают через новый сервис.

### Phase 2: Agent Mode + Basic Tools (4-5 дней)

- [ ] `mode: 'agent'` в ClaudeAgentService
- [ ] Search tools: `search_messages`, `get_message_context`
- [ ] Entity tools: `get_entity`, `find_entity`, `get_interactions`
- [ ] Logging hook
- [ ] Integration тесты

**DoD:** Работает Recall сценарий.

### Phase 3: Full Tools + Hooks (3-4 дня)

- [ ] `get_open_items` tool
- [ ] `get_context` tool
- [ ] Action tools: `send_telegram`, `create_reminder`
- [ ] Approval hook
- [ ] E2E тест Recall + Act

**DoD:** Работает Act с approval.

---

## 5. Примеры использования

### One-shot (существующие задачи)

```typescript
const { data } = await claudeAgentService.call<SummarizationResult>({
  mode: 'oneshot',
  taskType: 'summarization',
  prompt: buildPrompt(messages),
  schema: summarizationSchema,
  model: 'sonnet',
});
```

### Agent: Recall

```typescript
const { data } = await claudeAgentService.call<string>({
  mode: 'agent',
  taskType: 'recall',
  prompt: 'Кто советовал юриста по IP?',
  tools: [...createSearchTools(searchService), ...createEntityTools(entityService, interactionService, openItemService)],
  maxTurns: 10,
  budgetUsd: 0.20,
});
// Claude: search → refine → get_entity → answer
```

### Agent: Meeting Prep

```typescript
const { data } = await claudeAgentService.call<MeetingBrief>({
  mode: 'agent',
  taskType: 'meeting_prep',
  prompt: 'Brief к встрече с Петром из Сбера',
  tools: [...createSearchTools(searchService), ...createEntityTools(entityService, interactionService, openItemService)],
  maxTurns: 15,
});
// Claude: find_entity → get_entity → get_interactions → get_open_items → brief
```

### Agent: Act with Approval

```typescript
const { data } = await claudeAgentService.call<ActionResult>({
  mode: 'agent',
  taskType: 'action',
  prompt: 'Напиши Сергею что встреча переносится',
  tools: [...createEntityTools(entityService, interactionService, openItemService), ...createActionTools(telegramService, reminderService)],
  hooks: createApprovalHook(notificationService, entityService),
  maxTurns: 5,
});
// Claude: find_entity → send_telegram → [APPROVAL] → sent
```

---

## 6. Оценка

| Фаза | Scope | Дни |
|------|-------|-----|
| Phase 1 | Infrastructure + Migration | 4-5 |
| Phase 2 | Agent Mode + Basic Tools | 4-5 |
| Phase 3 | Full Tools + Hooks | 3-4 |
| **Итого** | | **11-14** |

---

## 7. Чеклист

### Must Have
- [ ] `ClaudeAgentService` с oneshot и agent modes
- [ ] Миграция всех 4 сервисов
- [ ] Search и entity tools
- [ ] Логирование в `claude_agent_runs`
- [ ] Unit тесты

### Should Have
- [ ] Action tools с approval
- [ ] Integration тесты

### Could Have
- [ ] Session management
- [ ] Cost dashboard
