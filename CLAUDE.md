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
