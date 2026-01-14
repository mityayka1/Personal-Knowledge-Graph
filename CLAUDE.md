# PKG - Personal Knowledge Graph

## Обзор проекта

Personal Knowledge Graph — система для интеллектуального хранения и извлечения контекста взаимодействий с людьми и организациями из различных источников коммуникации (Telegram, телефонные звонки, видео-встречи).

**Цель:** Перед любым взаимодействием получить компактный, релевантный контекст: кто это, о чём договаривались, какие открытые вопросы.

## Архитектура

Система состоит из трёх микросервисов:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Telegram     │     │    PKG Core     │     │     Worker      │
│    Adapter      │────►│    Service      │◄────│    (n8n)        │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                        ┌────────▼────────┐
                        │   PostgreSQL    │
                        │   + pgvector    │
                        └─────────────────┘
```

- **Telegram Adapter** — подключение к Telegram (GramJS), session management, отправка данных в PKG Core
- **PKG Core** — центральный сервис с API, entity management, search, хранение данных
- **Worker (n8n)** — асинхронные задачи: транскрипция, LLM-анализ через Claude Code CLI

## Документация

| Документ | Описание |
|----------|----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Архитектура сервисов, sequence diagrams, deployment |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Модель данных, ER-диаграмма, описание таблиц |
| [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) | REST API контракты между сервисами |
| [docs/PROCESSES.md](docs/PROCESSES.md) | Детальные бизнес-процессы с flow diagrams |
| [docs/USER_STORIES.md](docs/USER_STORIES.md) | User Stories для MVP и Post-MVP |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Глоссарий терминов |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Руководство по деплою на сервер |

## Схема БД (TypeORM Entities)

Entities находятся в директории `entities/`:

| Entity | Описание |
|--------|----------|
| `entity.entity.ts` | Person или Organization |
| `entity-identifier.entity.ts` | Идентификаторы (telegram_id, phone, email) |
| `entity-fact.entity.ts` | Структурированные факты с историей |
| `interaction.entity.ts` | Сессии чатов, звонки, встречи |
| `interaction-participant.entity.ts` | Участники взаимодействий |
| `message.entity.ts` | Сообщения из Telegram |
| `transcript-segment.entity.ts` | Сегменты транскрипции звонков |
| `interaction-summary.entity.ts` | Summaries для tiered retrieval |
| `pending-entity-resolution.entity.ts` | Ожидающие связывания идентификаторы |
| `pending-fact.entity.ts` | Факты на подтверждении |
| `job.entity.ts` | Очередь асинхронных задач |

## Технологический стек

- **Backend:** Node.js / TypeScript / NestJS
- **Database:** PostgreSQL 16 + pgvector
- **ORM:** TypeORM
- **Telegram:** GramJS (MTProto)
- **Queue:** BullMQ (Redis)
- **Embeddings:** OpenAI text-embedding-3-small (1536 dim)
- **LLM:** Claude via Claude Code CLI
- **Transcription:** Whisper
- **Workflow:** n8n (self-hosted)

## Ключевые концепции

### Entity Resolution
Процесс связывания входящих идентификаторов (telegram_user_id, phone) с Entity. При неизвестном идентификаторе создаётся `PendingEntityResolution`, который может быть resolved вручную или автоматически через LLM suggestions.

### Session Management
Telegram сообщения группируются в sessions (Interactions). Новая сессия создаётся при gap > 4 часов между сообщениями.

### Tiered Retrieval
Стратегия извлечения данных: недавние взаимодействия (< 7 дней) доступны полностью, старые — через compact summaries.

### Entity Facts
Структурированные атрибуты сущностей (birthday, position, phone) с историей изменений (valid_from/valid_until) и источником (manual, extracted, imported).

## Правила разработки

1. **API-First:** Все взаимодействия между сервисами через REST API согласно `docs/API_CONTRACTS.md`
2. **Source-Agnostic Core:** PKG Core не зависит от конкретных источников данных
3. **Async Processing:** Тяжёлые задачи (transcription, LLM) выполняются асинхронно через Worker
4. **Embeddings:** Генерируются асинхронно в очереди, не блокируют основной поток

## Git Workflow

### Merge Strategy
**ЗАПРЕЩЕНО использовать Squash Merge при принятии PR.**

Причины:
- Squash создаёт новый коммит, отличный от оригинальных → ветки показывают "различия" даже после merge
- Теряется история отдельных коммитов и их авторство
- Усложняет отслеживание что было смержено, а что нет

**Используй обычный Merge Commit** (`gh pr merge --merge`) или **Rebase Merge** (`gh pr merge --rebase`).

```bash
# Правильно
gh pr merge <N> --merge --delete-branch

# Неправильно
gh pr merge <N> --squash  # ❌ ЗАПРЕЩЕНО
```

### Branch Cleanup
После merge PR удаляй ветку (флаг `--delete-branch`). Не оставляй stale branches.

## Claude Agent SDK — Правила работы

PKG использует Claude Agent SDK для AI-функций. При работе с agent tools соблюдай следующие правила:

### Создание Tools

```typescript
// ОБЯЗАТЕЛЬНО: .describe() для каждого параметра
tool('tool_name', 'Description for Claude', {
  param: z.string().describe('What this param does'),  // ✅
  id: z.string().uuid().describe('Entity UUID'),       // ✅
  limit: z.number().default(20).describe('Max items'), // ✅
}, handler);

// ЗАПРЕЩЕНО: параметры без описания
{ query: z.string() }  // ❌ Claude не поймёт назначение
```

### Error Handling

```typescript
// Tool errors — recoverable, Claude видит и адаптируется
return toolError('Entity not found. Try searching by name first.');

// Empty results — НЕ ошибка, нормальный результат
return toolEmptyResult('messages matching query');

// Protocol errors — критические, прерывают выполнение
throw new Error('Database connection failed');
```

**Правило:** Каждое сообщение об ошибке должно подсказывать как исправить ситуацию.

### NestJS Providers

```typescript
@Injectable()
export class MyToolsProvider {
  private cachedTools: ToolDefinition[] | null = null;  // Кэширование обязательно

  getTools(): ToolDefinition[] {
    if (!this.cachedTools) {
      this.cachedTools = this.createTools();
    }
    return this.cachedTools;
  }
}
```

### Circular Dependencies

```typescript
// При циклических зависимостях используй @Optional + forwardRef
@Optional()
@Inject(forwardRef(() => ContextService))
private readonly contextService: ContextService | null,
```

### Tool Categories

При вызове агента указывай минимально необходимые категории:

| Категория | Tools | Когда использовать |
|-----------|-------|-------------------|
| `search` | search_messages, search_entities | Поиск информации |
| `entities` | get_entity_details, list_entities | Работа с людьми/организациями |
| `events` | create_reminder, list_events | Напоминания, события |
| `context` | get_entity_context | Синтез контекста |
| `all` | Все tools | Только если реально нужны все |

### Code Review Checklist

При review agent tools проверяй:
- [ ] Все Zod поля с `.describe()`
- [ ] `toolError()` с actionable messages
- [ ] `toolEmptyResult()` для пустых результатов (не isError!)
- [ ] Кэширование tools в provider
- [ ] Нет мутации входных параметров
- [ ] Logger с контекстом tool name

## AI Team

Команда AI-субагентов для проекта PKG. Каждый агент специализируется на своей области.

| Агент | Роль | Файл |
|-------|------|------|
| **tech-lead** | Архитектурные решения, code review | @./.claude/agents/tech-lead.md |
| **product-owner** | User stories, приоритеты, scope | @./.claude/agents/product-owner.md |
| **backend-developer** | NestJS/TypeORM разработка | @./.claude/agents/backend-developer.md |
| **qa-engineer** | Тестирование, quality assurance | @./.claude/agents/qa-engineer.md |
| **devops** | Docker, CI/CD, deployment | @./.claude/agents/devops.md |
| **telegram-expert** | GramJS/MTProto, Telegram Adapter | @./.claude/agents/telegram-expert.md |
| **n8n-expert** | Workflow automation, Worker | @./.claude/agents/n8n-expert.md |
| **pgvector-expert** | PostgreSQL, vector search | @./.claude/agents/pgvector-expert.md |
| **openai-expert** | Embeddings API | @./.claude/agents/openai-expert.md |
| **claude-cli-expert** | Claude CLI программный вызов из Node.js | @./.claude/agents/claude-cli-expert.md |
| **claude-code-expert** | Claude Code CLI: установка, авторизация, конфигурация | @./.claude/agents/claude-code-expert.md |
| **claude-agent-sdk-expert** | Claude Agent SDK: tools, MCP, архитектура агентов | @./.claude/agents/claude-agent-sdk-expert.md |

### Использование агентов

Для активации агента используйте импорт в промпте:
```
@./.claude/agents/tech-lead.md
```

Или укажите роль в запросе:
```
Выступай как tech-lead. Проведи code review для...
```

### Документация команды
- [Team Architecture](docs/team-architecture.md) — полное описание команды и обоснование
