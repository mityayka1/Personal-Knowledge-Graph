# Personal Knowledge Graph (PKG)

## Обзор

Personal Knowledge Graph — система для интеллектуального хранения и извлечения контекста взаимодействий с людьми и организациями из различных источников коммуникации.

**Цель:** Перед любым взаимодействием (звонок, встреча, переписка) получить компактный, релевантный контекст: кто это, о чём договаривались, какие открытые вопросы.

## Ключевые возможности

### MVP
- Сбор сообщений из Telegram (userbot) в реальном времени
- Загрузка и транскрипция телефонных разговоров
- Entity Resolution — связывание идентификаторов с людьми/организациями
- Генерация структурированного контекста по запросу
- Поиск по истории взаимодействий (FTS + semantic)

### Post-MVP
- Видео-встречи (Google Meet, Zoom)
- Автоматическое извлечение фактов из переписки
- Интеграция с календарём
- Мобильное приложение

## Архитектура

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Telegram     │     │    PKG Core     │     │     Worker      │
│    Adapter      │────►│    Service      │◄────│    (n8n)        │
│                 │     │                 │     │                 │
│  • Userbot      │     │  • Entities     │     │  • Transcribe   │
│  • Real-time    │     │  • Search       │     │  • LLM tasks    │
│  • Voice queue  │     │  • API          │     │  • Schedules    │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                        ┌────────▼────────┐
                        │   PostgreSQL    │
                        │   + pgvector    │
                        └─────────────────┘
```

## Документация

| # | Документ | Описание |
|---|----------|----------|
| 1 | [DATA_MODEL.md](./DATA_MODEL.md) | Модель данных, описание таблиц и связей |
| 2 | [entities/](./entities/) | TypeORM entities (схема БД) |
| 3 | [ARCHITECTURE.md](./ARCHITECTURE.md) | Архитектура сервисов, взаимодействие, deployment |
| 4 | [API_CONTRACTS.md](./API_CONTRACTS.md) | REST API контракты между сервисами |
| 5 | [PROCESSES.md](./PROCESSES.md) | Детальное описание бизнес-процессов |
| 6 | [USER_STORIES.md](./USER_STORIES.md) | User Stories для MVP и Post-MVP |
| 7 | [GLOSSARY.md](./GLOSSARY.md) | Глоссарий терминов |

## Технологический стек

| Layer | Technology |
|-------|------------|
| Database | PostgreSQL 16 + pgvector |
| Backend | Node.js / TypeScript / NestJS |
| ORM | TypeORM |
| Telegram | GramJS |
| Queue | BullMQ (Redis) |
| Embeddings | OpenAI text-embedding-3-small |
| LLM | Claude (via Claude Code CLI) |
| Transcription | Whisper |
| Workflow | n8n (self-hosted) |

## Quick Start

```bash
# 1. Start infrastructure
docker-compose up -d postgres redis n8n

# 2. Run migrations
cd pkg-core && npm run migration:run

# 3. Start services
cd pkg-core && npm run start:dev
cd telegram-adapter && npm run start:dev
```
