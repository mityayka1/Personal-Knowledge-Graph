# Personal Knowledge Graph (PKG)

## Обзор

Personal Knowledge Graph — система для интеллектуального хранения и извлечения контекста взаимодействий с людьми и организациями из различных источников коммуникации.

**Цель:** Перед любым взаимодействием (звонок, встреча, переписка) получить компактный, релевантный контекст: кто это, о чём договаривались, какие открытые вопросы.

## Текущий статус

### Реализовано (MVP)
- **Telegram Integration** — сбор сообщений в реальном времени через GramJS
- **Session Management** — автоматическое создание сессий (gap > 4ч)
- **Entity Resolution** — связывание идентификаторов с людьми/организациями
- **Embedding Generation** — автоматическая генерация embeddings через OpenAI
- **Hybrid Search** — FTS + Vector + Hybrid (RRF) поиск
- **Context Generation** — синтез контекста по entity

### В разработке
- Транскрипция телефонных разговоров (Whisper)
- Автоматическое извлечение фактов (LLM)
- Interaction summaries

## Архитектура

```
┌─────────────────┐     HTTP      ┌─────────────────┐     BullMQ    ┌─────────────┐
│    Telegram     │──────────────►│    PKG Core     │◄─────────────►│   OpenAI    │
│    Adapter      │   /messages   │    :3000        │   embeddings  │   API       │
│    :3001        │               └────────┬────────┘               └─────────────┘
└────────┬────────┘                        │
         │                          ┌──────▼──────┐
    GramJS/MTProto                  │  PostgreSQL │
         │                          │  + pgvector │
         ▼                          └──────┬──────┘
   Telegram API                            │
                                    ┌──────▼──────┐
                                    │    Redis    │
                                    │   (BullMQ)  │
                                    └─────────────┘
```

## Сервисы

| Сервис | Порт | Описание |
|--------|------|----------|
| PKG Core | 3000 | REST API, entities, search, embeddings |
| Telegram Adapter | 3001 | GramJS userbot, message processing |
| Bull Board | 3002 | BullMQ monitoring dashboard |
| PostgreSQL | 5432 | Database + pgvector |
| Redis | 6379 | BullMQ queue backend |
| n8n | 5678 | Workflow automation (LLM tasks) |

## Quick Start

### 1. Установка зависимостей

```bash
pnpm install
```

### 2. Запуск инфраструктуры

```bash
cd docker
docker-compose up -d postgres redis
```

### 3. Настройка Telegram (первый раз)

```bash
cd apps/telegram-adapter
cp .env.example .env
# Добавить TELEGRAM_API_ID и TELEGRAM_API_HASH
pnpm auth  # Авторизация в Telegram
```

### 4. Настройка PKG Core

```bash
cd apps/pkg-core
cp .env.example .env
# Добавить OPENAI_API_KEY
```

### 5. Запуск сервисов

```bash
# Terminal 1: PKG Core
cd apps/pkg-core && pnpm start:dev

# Terminal 2: Telegram Adapter
cd apps/telegram-adapter && pnpm start:dev

# Terminal 3: Bull Board (опционально)
cd apps/bull-board && npm start
```

## API Примеры

### Поиск сообщений

```bash
# Hybrid search (FTS + Vector)
curl -X POST http://localhost:3000/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query": "обсуждение проекта", "type": "hybrid", "limit": 10}'
```

### Получение контекста по entity

```bash
curl -X POST http://localhost:3000/api/v1/context \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "uuid-here"}'
```

### Получение interaction с сообщениями

```bash
curl http://localhost:3000/api/v1/interactions/{id}
```

## Структура проекта

```
PKG/
├── apps/
│   ├── pkg-core/           # NestJS REST API
│   ├── telegram-adapter/   # GramJS userbot
│   └── bull-board/         # BullMQ monitoring
├── packages/
│   ├── entities/           # TypeORM entities
│   └── shared/             # Shared types
├── docker/
│   ├── docker-compose.yml
│   └── Dockerfile.*
└── docs/                   # Documentation
```

## Технологический стек

| Layer | Technology |
|-------|------------|
| Database | PostgreSQL 16 + pgvector |
| Backend | Node.js / TypeScript / NestJS |
| ORM | TypeORM |
| Telegram | GramJS (MTProto) |
| Queue | BullMQ (Redis) |
| Embeddings | OpenAI text-embedding-3-small (1536 dim) |
| Monitoring | Bull Board |
| Workflow | n8n (LLM tasks) |

## Документация

| Документ | Описание |
|----------|----------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Архитектура сервисов |
| [DATA_MODEL.md](docs/DATA_MODEL.md) | Модель данных |
| [API_CONTRACTS.md](docs/API_CONTRACTS.md) | REST API контракты |
| [PROCESSES.md](docs/PROCESSES.md) | Бизнес-процессы |
| [USER_STORIES.md](docs/USER_STORIES.md) | User Stories |
| [GLOSSARY.md](docs/GLOSSARY.md) | Глоссарий |

## Environment Variables

### PKG Core
```
DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE
REDIS_HOST, REDIS_PORT
OPENAI_API_KEY
```

### Telegram Adapter
```
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION_STRING
PKG_CORE_URL
```

## License

MIT
