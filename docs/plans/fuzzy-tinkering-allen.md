# Plan: Устранение циклических зависимостей (forwardRef)

## Context

После деплоя Phase E (Knowledge Packing) получили два каскадных DI-сбоя:
1. `UndefinedModuleException` — SegmentationModule не мог резолвить ClaudeAgentModule
2. `UnknownDependenciesException` — KnowledgeToolsProvider не находил TypeORM repos в контексте ClaudeAgentModule

**Корневая причина:** ClaudeAgentModule — "хаб" с 7 forwardRef-импортами, создающий хрупкие циклические зависимости. Каждый новый модуль (SegmentationModule) рискует сломать DI при деплое.

### Текущий граф зависимостей (циклы)

```
ContextModule ──────→ ClaudeAgentModule ──────→ ContextModule       ← CYCLE
EntityModule ───────→ ClaudeAgentModule ──────→ EntityModule        ← CYCLE
NotificationModule ─→ ClaudeAgentModule ──────→ NotificationModule  ← CYCLE
SegmentationModule ─→ ClaudeAgentModule ──────→ SegmentationModule  ← CYCLE
ExtractionModule ───→ ClaudeAgentModule ──────→ ExtractionModule    ← CYCLE
SummarizationModule → ClaudeAgentModule                             (one-way, OK)
TelegramMiniApp ────→ ClaudeAgentModule                             (one-way, OK)
```

**Двойная роль ClaudeAgentModule:**
1. Предоставляет core AI-сервисы (ClaudeAgentService, SchemaLoaderService) — это нужно всем доменным модулям
2. Хостит tool providers, зависящие от доменных сервисов — это требует импорта доменных модулей

---

## Решение: Декомпозиция ClaudeAgentModule + Registration Pattern

### Целевой граф зависимостей (без циклов)

```
ContextModule ──────→ ClaudeAgentCoreModule    (one-way ✅)
EntityModule ───────→ ClaudeAgentCoreModule    (one-way ✅)
NotificationModule ─→ ClaudeAgentCoreModule    (one-way ✅)
SegmentationModule ─→ ClaudeAgentCoreModule    (one-way ✅)
ExtractionModule ───→ ClaudeAgentCoreModule    (one-way ✅)
SummarizationModule → ClaudeAgentCoreModule    (one-way ✅)
TelegramMiniApp ────→ ClaudeAgentCoreModule    (one-way ✅)

ClaudeAgentModule ──→ ClaudeAgentCoreModule    (one-way ✅)
ClaudeAgentModule ──→ all domain modules       (one-way ✅, домены НЕ импортируют ClaudeAgentModule)
```

---

## Шаг 1: Создать ClaudeAgentCoreModule

**Новый файл:** `apps/pkg-core/src/modules/claude-agent/claude-agent-core.module.ts`

Чистый модуль без доменных зависимостей:

```typescript
@Module({
  imports: [
    TypeOrmModule.forFeature([ClaudeAgentRun]),
    // Только ConfigModule (implicit через NestJS)
  ],
  providers: [
    ClaudeAgentService,
    SchemaLoaderService,
    RecallSessionService,
    ToolsRegistryService,  // Refactored — без DI-зависимостей от tool providers
  ],
  exports: [
    ClaudeAgentService,
    SchemaLoaderService,
    RecallSessionService,
    ToolsRegistryService,
  ],
})
export class ClaudeAgentCoreModule {}
```

**Зависимости провайдеров (подтверждено чтением кода):**
| Провайдер | Зависимости | Доменные? |
|-----------|-------------|-----------|
| ClaudeAgentService | ConfigService, ClaudeAgentRun repo, ToolsRegistryService | Нет ✅ |
| SchemaLoaderService | ConfigService | Нет ✅ |
| RecallSessionService | @InjectRedis() | Нет ✅ |
| ToolsRegistryService | **Текущие:** 8 tool providers через @Optional+forwardRef → **После:** никаких | Нет ✅ |

---

## Шаг 2: Рефакторинг ToolsRegistryService — Registration Pattern

**Файл:** `apps/pkg-core/src/modules/claude-agent/tools-registry.service.ts`

### Было (constructor injection с forwardRef):

```typescript
constructor(
  private readonly searchToolsProvider: SearchToolsProvider,          // direct
  private readonly entityToolsProvider: EntityToolsProvider,          // direct
  private readonly eventToolsProvider: EventToolsProvider,            // direct
  @Optional() @Inject(forwardRef(() => ContextToolsProvider))
  private readonly contextToolsProvider: ContextToolsProvider | null, // forwardRef
  @Optional() @Inject(forwardRef(() => ActionToolsProvider))
  private readonly actionToolsProvider: ActionToolsProvider | null,   // forwardRef
  // ... ещё 3 forwardRef
)
```

### Стало (registration pattern):

```typescript
@Injectable()
export class ToolsRegistryService {
  private readonly providers = new Map<ToolCategory, ToolsProviderInterface>();
  private cachedAllTools: ToolDefinition[] | null = null;
  private categoryCache = new Map<string, ToolDefinition[]>();

  constructor() {} // Пустой конструктор — нет доменных зависимостей!

  /**
   * Register a tool provider for a category.
   * Called by tool providers in their onModuleInit().
   */
  registerProvider(category: ToolCategory, provider: ToolsProviderInterface): void {
    this.providers.set(category, provider);
    this.invalidateCache();
    this.logger.log(`Registered tool provider for category: ${category}`);
  }

  // getAllTools(), getToolsByCategory(), createMcpServer() — API не меняется
  // Внутри вместо this.searchToolsProvider.getTools() → this.providers.get('search')?.getTools()
}
```

### Интерфейс ToolsProviderInterface:

**Новый файл:** `apps/pkg-core/src/modules/claude-agent/tools/tools-provider.interface.ts`

```typescript
export interface ToolsProviderInterface {
  getTools(): ToolDefinition[];
  hasTools?(): boolean;
}
```

---

## Шаг 3: Tool Providers — самостоятельная регистрация

Каждый tool provider реализует `OnModuleInit` и регистрируется в `ToolsRegistryService`:

```typescript
@Injectable()
export class SearchToolsProvider implements OnModuleInit, ToolsProviderInterface {
  constructor(
    private readonly searchService: SearchService,
    private readonly toolsRegistry: ToolsRegistryService,  // inject from CoreModule
  ) {}

  onModuleInit() {
    this.toolsRegistry.registerProvider('search', this);
  }

  getTools(): ToolDefinition[] { /* ... без изменений ... */ }
}
```

### Куда перенести tool providers

| Provider | Текущее расположение | Новый модуль (providers) | Файл остаётся |
|----------|---------------------|--------------------------|----------------|
| SearchToolsProvider | ClaudeAgentModule | ClaudeAgentModule* | `claude-agent/tools/` |
| EntityToolsProvider | ClaudeAgentModule | EntityModule | `claude-agent/tools/` |
| EventToolsProvider | ClaudeAgentModule | ClaudeAgentModule* | `claude-agent/tools/` |
| ContextToolsProvider | ClaudeAgentModule | ContextModule | `claude-agent/tools/` |
| ActionToolsProvider | ClaudeAgentModule | NotificationModule | `claude-agent/tools/` |
| ActivityToolsProvider | ClaudeAgentModule | ActivityModule | `claude-agent/tools/` |
| DataQualityToolsProvider | DataQualityModule | DataQualityModule | `data-quality/` (уже там) |
| KnowledgeToolsProvider | SegmentationModule | SegmentationModule | `segmentation/` (уже там) |

*SearchToolsProvider и EventToolsProvider остаются в ClaudeAgentModule, т.к. SearchModule и EntityEventModule не создают циклов.

**Физические файлы НЕ перемещаются** — только меняется, в каком модуле они зарегистрированы как providers. Это минимизирует diff и риск.

---

## Шаг 4: Обновить доменные модули

### 4a. Заменить импорт ClaudeAgentModule → ClaudeAgentCoreModule

Для модулей, которым нужен только ClaudeAgentService/SchemaLoader:

| Модуль | Файл | Было | Стало |
|--------|------|------|-------|
| ContextModule | `context/context.module.ts` | `forwardRef(() => ClaudeAgentModule)` | `ClaudeAgentCoreModule` |
| EntityModule | `entity/entity.module.ts` | `ClaudeAgentModule` | `ClaudeAgentCoreModule` |
| NotificationModule | `notification/notification.module.ts` | `ClaudeAgentModule` | `ClaudeAgentCoreModule` |
| SegmentationModule | `segmentation/segmentation.module.ts` | `forwardRef(() => ClaudeAgentModule)` | `ClaudeAgentCoreModule` |
| ExtractionModule | `extraction/extraction.module.ts` | `ClaudeAgentModule` | `ClaudeAgentCoreModule` |
| SummarizationModule | `summarization/summarization.module.ts` | `ClaudeAgentModule` | `ClaudeAgentCoreModule` |
| TelegramMiniApp | `telegram-mini-app/telegram-mini-app.module.ts` | `ClaudeAgentModule` | `ClaudeAgentCoreModule` |

### 4b. Добавить tool providers в доменные модули

Модули, принимающие tool providers, должны:
1. Импортировать `ClaudeAgentCoreModule` (для ToolsRegistryService)
2. Добавить tool provider в `providers` array

Пример для ContextModule:

```typescript
@Module({
  imports: [
    ClaudeAgentCoreModule,  // для ClaudeAgentService + ToolsRegistryService
    // ... остальные импорты
  ],
  providers: [
    ContextService,
    ContextToolsProvider,  // NEW — раньше был в ClaudeAgentModule
  ],
  exports: [ContextService],
})
```

### 4c. Убрать @Optional() + forwardRef() из tool providers

Пример для ContextToolsProvider:

```typescript
// БЫЛО:
@Optional()
@Inject(forwardRef(() => ContextService))
private readonly contextService: ContextService | null,

// СТАЛО (ContextToolsProvider теперь в ContextModule, ContextService доступен напрямую):
private readonly contextService: ContextService,
```

---

## Шаг 5: Упростить ClaudeAgentModule

**Файл:** `apps/pkg-core/src/modules/claude-agent/claude-agent.module.ts`

```typescript
@Module({
  imports: [
    ClaudeAgentCoreModule,
    SearchModule,
    EntityEventModule,
    // Больше НЕ нужны forwardRef — домены не импортируют ClaudeAgentModule
  ],
  controllers: [
    ClaudeAgentController,
    AgentController,
    ActivityEnrichmentController,
  ],
  providers: [
    SearchToolsProvider,   // остаётся здесь (SearchModule не создаёт цикл)
    EventToolsProvider,    // остаётся здесь (EntityEventModule не создаёт цикл)
  ],
  exports: [ClaudeAgentCoreModule],  // re-export Core для app.module
})
export class ClaudeAgentModule {}
```

**Результат:** 0 forwardRef в ClaudeAgentModule (было 7).

---

## Шаг 6: Обновить AppModule

**Файл:** `apps/pkg-core/src/app.module.ts`

Оставить `ClaudeAgentModule` в imports — он теперь re-экспортирует CoreModule + предоставляет контроллеры.

---

## Файлы для изменения

| Файл | Тип | Описание |
|------|-----|----------|
| `claude-agent/claude-agent-core.module.ts` | CREATE | Новый Core-модуль |
| `claude-agent/tools/tools-provider.interface.ts` | CREATE | Интерфейс для tool providers |
| `claude-agent/tools-registry.service.ts` | MODIFY | Registration pattern вместо DI injection |
| `claude-agent/claude-agent.module.ts` | MODIFY | Убрать 7 forwardRef, оставить Core + controllers |
| `claude-agent/tools/search-tools.provider.ts` | MODIFY | + OnModuleInit + registerProvider() |
| `claude-agent/tools/entity-tools.provider.ts` | MODIFY | + OnModuleInit + registerProvider() |
| `claude-agent/tools/event-tools.provider.ts` | MODIFY | + OnModuleInit + registerProvider() |
| `claude-agent/tools/context-tools.provider.ts` | MODIFY | + OnModuleInit + registerProvider(), убрать @Optional |
| `claude-agent/tools/action-tools.provider.ts` | MODIFY | + OnModuleInit + registerProvider(), убрать @Optional |
| `claude-agent/tools/activity-tools.provider.ts` | MODIFY | + OnModuleInit + registerProvider() |
| `data-quality/data-quality-tools.provider.ts` | MODIFY | + OnModuleInit + registerProvider() |
| `segmentation/knowledge-tools.provider.ts` | MODIFY | + OnModuleInit + registerProvider() |
| `context/context.module.ts` | MODIFY | CoreModule + ContextToolsProvider |
| `entity/entity.module.ts` | MODIFY | CoreModule + EntityToolsProvider |
| `notification/notification.module.ts` | MODIFY | CoreModule + ActionToolsProvider |
| `activity/activity.module.ts` | MODIFY | CoreModule + ActivityToolsProvider |
| `segmentation/segmentation.module.ts` | MODIFY | CoreModule (уже KnowledgeToolsProvider) |
| `data-quality/data-quality.module.ts` | MODIFY | CoreModule (уже DataQualityToolsProvider) |
| `extraction/extraction.module.ts` | MODIFY | CoreModule |
| `summarization/summarization.module.ts` | MODIFY | CoreModule |
| `telegram-mini-app/telegram-mini-app.module.ts` | MODIFY | CoreModule |

---

## Порядок реализации

| # | Шаг | Зависимости | Риск |
|---|-----|-------------|------|
| 1 | Создать `ToolsProviderInterface` | Нет | Низкий |
| 2 | Рефакторинг `ToolsRegistryService` → registration pattern | #1 | Средний |
| 3 | Создать `ClaudeAgentCoreModule` | #2 | Низкий |
| 4 | Обновить все tool providers (+ OnModuleInit) | #1, #2 | Средний |
| 5 | Обновить доменные модули (импорты + providers) | #3, #4 | Высокий |
| 6 | Упростить `ClaudeAgentModule` | #5 | Средний |
| 7 | Компиляция + тесты | #6 | — |

Шаги 1-3 можно делать без ломающих изменений. Шаги 4-6 нужно делать атомарно (одним коммитом), т.к. промежуточные состояния не скомпилируются.

---

## Существующие функции для reuse

| Функция/Сервис | Файл | Использование |
|----------------|------|---------------|
| `ToolDefinition` type | `claude-agent/tools/tool.types.ts` | Типизация tools |
| `toolSuccess/toolError/toolEmptyResult` | `claude-agent/tools/tool.types.ts` | Результаты tools |
| `ToolCategory` type | `claude-agent/claude-agent.types.ts` | Категории для registry |
| `createSdkMcpServer` | `@anthropic-ai/claude-agent-sdk` | MCP server creation |

---

## Verification

1. **Компиляция:** `cd apps/pkg-core && npx tsc --noEmit` — без ошибок
2. **Grep проверка:** `grep -r "forwardRef" src/modules/claude-agent/` — должен быть 0 результатов в claude-agent
3. **Unit тесты:** `cd apps/pkg-core && npx jest --passWithNoTests` — все проходят
4. **Runtime проверка:** `pnpm dev` → проверить что все tool categories доступны через агент
5. **Tool registration:** Добавить лог в ToolsRegistryService.registerProvider() → при старте должны зарегистрироваться все 8 категорий
6. **Agent call:** POST `/agent/recall` с query — должен использовать search tools
7. **Production deploy:** `docker compose build --no-cache pkg-core && docker compose up -d pkg-core` — container healthy

---

## Ожидаемый результат

| Метрика | До | После |
|---------|-----|-------|
| forwardRef в claude-agent.module.ts | 7 | 0 |
| @Optional+forwardRef в tools-registry | 5 | 0 |
| @Optional+forwardRef в tool providers | 3+ | 0 |
| Циклических зависимостей через ClaudeAgentModule | 5 | 0 |
| Модулей | 1 (ClaudeAgentModule) | 2 (Core + Tools/Controllers) |
| Риск DI-сбоя при добавлении нового модуля | Высокий | Низкий |
