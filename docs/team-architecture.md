# Team Architecture — PKG AI Agents

## Обзор

Данный документ описывает архитектуру команды AI-субагентов для проекта Personal Knowledge Graph (PKG).

## Анализ проекта

### Технологический стек

| Категория | Технология |
|-----------|------------|
| Backend | Node.js / TypeScript / NestJS |
| Database | PostgreSQL 16 + pgvector |
| ORM | TypeORM |
| Telegram | GramJS (MTProto) |
| Queue | BullMQ (Redis) |
| Embeddings | OpenAI text-embedding-3-small |
| LLM | Claude via Claude Code CLI |
| Transcription | Whisper |
| Workflow | n8n (self-hosted) |

### Архитектура системы

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

### Ключевые интеграции

1. **Telegram** — GramJS/MTProto userbot
2. **OpenAI** — embeddings API (text-embedding-3-small)
3. **n8n** — workflow automation для async задач
4. **pgvector** — vector similarity search

## Состав команды

### Базовые агенты (всегда необходимы)

| Агент | Обоснование |
|-------|-------------|
| **tech-lead** | Архитектурные решения критичны для микросервисной системы. Контроль качества кода, соответствие API контрактам. |
| **product-owner** | Проект в стадии MVP, важно четко определять scope и приоритеты. User stories уже документированы. |
| **backend-developer** | Основной объем работы — backend на NestJS/TypeORM. |

### Агенты по стеку

| Агент | Обоснование |
|-------|-------------|
| **qa-engineer** | Тестирование критично для системы с множеством интеграций (Telegram, OpenAI, n8n). |
| **devops** | Три микросервиса требуют Docker orchestration, CI/CD pipelines. |

### Эксперты по сервисам

| Агент | Сервис | Обоснование |
|-------|--------|-------------|
| **telegram-expert** | Telegram API | GramJS/MTProto специфичен, требует глубоких знаний. Session management, voice handling. |
| **n8n-expert** | n8n | Workflow automation центральная для async задач. Claude CLI интеграция, Whisper. |
| **pgvector-expert** | PostgreSQL + pgvector | Vector search — ключевая фича. Hybrid search, индексирование критичны для performance. |
| **openai-expert** | OpenAI API | Embeddings генерация требует оптимизации: batching, rate limiting, cost management. |

## Матрица ответственности

```
                    Telegram   PKG Core   Worker    Database   DevOps
                    Adapter    Service    (n8n)
┌──────────────────┬──────────┬──────────┬─────────┬──────────┬────────┐
│ tech-lead        │    ◐     │    ●     │    ◐    │    ◐     │   ◐    │
│ product-owner    │    ○     │    ●     │    ◐    │    ○     │   ○    │
│ backend-developer│    ◐     │    ●     │    ○    │    ●     │   ○    │
│ qa-engineer      │    ◐     │    ●     │    ◐    │    ●     │   ○    │
│ devops           │    ◐     │    ◐     │    ◐    │    ◐     │   ●    │
│ telegram-expert  │    ●     │    ○     │    ○    │    ○     │   ○    │
│ n8n-expert       │    ○     │    ○     │    ●    │    ○     │   ○    │
│ pgvector-expert  │    ○     │    ◐     │    ○    │    ●     │   ○    │
│ openai-expert    │    ○     │    ◐     │    ◐    │    ○     │   ○    │
└──────────────────┴──────────┴──────────┴─────────┴──────────┴────────┘

● — Primary responsibility
◐ — Secondary/Support
○ — Minimal/No involvement
```

## Workflow взаимодействия

### Типичные сценарии

**Новая фича:**
```
product-owner → tech-lead → backend-developer → qa-engineer → devops
```

**Проблема с Telegram:**
```
telegram-expert → backend-developer → qa-engineer
```

**Оптимизация поиска:**
```
tech-lead → pgvector-expert → backend-developer → qa-engineer
```

**Новый workflow в n8n:**
```
product-owner → n8n-expert → qa-engineer
```

## Внешняя документация

### GramJS / Telegram
- [GramJS GitHub](https://github.com/gram-js/gramjs)
- [GramJS Docs](https://gram.js.org)
- [MTProto Protocol](https://core.telegram.org/mtproto)

### n8n
- [n8n Documentation](https://docs.n8n.io/)
- [n8n Workflows](https://docs.n8n.io/workflows/)
- [n8n Templates](https://n8n.io/workflows/)

### pgvector
- [pgvector GitHub](https://github.com/pgvector/pgvector)
- [Supabase pgvector Guide](https://supabase.com/docs/guides/database/extensions/pgvector)

### OpenAI
- [Embeddings Guide](https://platform.openai.com/docs/guides/embeddings)
- [API Reference](https://platform.openai.com/docs/api-reference/embeddings)
- [text-embedding-3-small](https://platform.openai.com/docs/models/text-embedding-3-small)

### NestJS / TypeORM
- [NestJS Documentation](https://docs.nestjs.com/)
- [TypeORM Documentation](https://typeorm.io/)
- [NestJS + TypeORM](https://docs.nestjs.com/recipes/sql-typeorm)

## Структура файлов

```
.claude/
└── agents/
    ├── tech-lead.md
    ├── product-owner.md
    ├── backend-developer.md
    ├── qa-engineer.md
    ├── devops.md
    ├── telegram-expert.md
    ├── n8n-expert.md
    ├── pgvector-expert.md
    └── openai-expert.md
```

## Рекомендации по использованию

### Когда использовать какого агента

| Задача | Агент |
|--------|-------|
| Архитектурное решение, code review | tech-lead |
| Что делать в первую очередь? | product-owner |
| Написать endpoint / service | backend-developer |
| Написать тесты | qa-engineer |
| Docker / CI/CD | devops |
| Проблема с Telegram API | telegram-expert |
| Создать workflow в n8n | n8n-expert |
| Оптимизировать vector search | pgvector-expert |
| Вопрос по embeddings | openai-expert |

### Комбинирование агентов

Для сложных задач можно комбинировать агентов:

```
@./.claude/agents/tech-lead.md
@./.claude/agents/backend-developer.md

Спроектируй и реализуй новый endpoint для...
```

## Версионирование

| Версия | Дата | Изменения |
|--------|------|-----------|
| 1.0 | 2025-01-07 | Первоначальное создание команды |
