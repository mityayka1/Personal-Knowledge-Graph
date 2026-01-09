# Архитектура PKG

## Обзор

Система построена по принципу микросервисной архитектуры с тремя основными сервисами, взаимодействующими через REST API.

## Сервисы

### 1. Telegram Adapter

**Назначение:** Подключение к Telegram и поставка сырых данных в PKG Core.

**Ответственность:**
- Подключение к Telegram как userbot (GramJS/MTProto)
- Получение сообщений в реальном времени
- Session management (определение границ сессий по gap > 4 часов)
- Отправка сообщений в PKG Core через API
- Сохранение voice messages в file storage и постановка в очередь транскрипции

**НЕ ответственность:**
- Entity resolution (только передаёт telegram_user_id)
- Хранение истории сообщений
- Транскрипция (только ставит задачу в очередь)

**Локальное состояние:**
- Telegram session (auth credentials)
- Active sessions map: `{ chat_id → last_message_timestamp }`
- Retry queue (при недоступности PKG Core)

```
┌────────────────────────────────────────────────────────────────┐
│                      TELEGRAM ADAPTER                          │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│  │   GramJS     │    │   Session    │    │   HTTP       │     │
│  │   Client     │───►│   Manager    │───►│   Client     │────►│ PKG Core
│  │              │    │              │    │              │     │
│  └──────────────┘    └──────────────┘    └──────────────┘     │
│         │                                                      │
│         │ voice                                                │
│         ▼                                                      │
│  ┌──────────────┐                                             │
│  │   File       │────────────────────────────────────────────►│ Storage
│  │   Handler    │                                             │
│  └──────────────┘                                             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

### 2. PKG Core Service

**Назначение:** Центральный сервис, владеющий данными и предоставляющий API.

**Ответственность:**
- Entity management (CRUD, merge, связи)
- Entity Resolution (identifier → entity mapping)
- Interaction management (создание, обновление)
- Message и segment storage
- Facts management (CRUD, история, pending)
- Search (Full-text + Vector + Hybrid)
- API для всех клиентов
- Генерация embeddings (async queue)
- **LLM задачи через Claude CLI** (fact extraction, context synthesis)

**НЕ ответственность:**
- Подключение к внешним источникам (Telegram, etc.)
- Транскрипция аудио (делегирует Worker)
- Сложные multi-step AI workflows (делегирует Worker/n8n)

```
┌────────────────────────────────────────────────────────────────┐
│                        PKG CORE                                │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │                     REST API Layer                        │ │
│  │  /entities  /interactions  /messages  /search  /context   │ │
│  └──────────────────────────────────────────────────────────┘ │
│                              │                                 │
│  ┌───────────┐  ┌───────────┴───────────┐  ┌───────────────┐ │
│  │  Entity   │  │     Interaction       │  │    Search     │ │
│  │  Service  │  │     Service           │  │    Service    │ │
│  └─────┬─────┘  └───────────┬───────────┘  └───────┬───────┘ │
│        │                    │                      │          │
│  ┌─────┴────────────────────┴──────────────────────┴───────┐ │
│  │                    Repository Layer                      │ │
│  └──────────────────────────┬──────────────────────────────┘ │
│                             │                                 │
│  ┌──────────────────────────┴──────────────────────────────┐ │
│  │              PostgreSQL + pgvector + Redis              │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

### 3. Worker Service (n8n)

**Назначение:** Выполнение сложных асинхронных задач, требующих визуальной отладки.

**Ответственность:**
- Транскрипция аудио (Whisper)
- Сложные multi-step AI workflows (когда нужна визуальная отладка в n8n):
  - Speaker mapping для звонков (требует итеративную отладку)
  - Сложные entity resolution cases
- Scheduled jobs (digest, cleanup)

**НЕ ответственность:**
- Хранение данных (всё через PKG Core API)
- Бизнес-логика entities/interactions
- Простые LLM задачи (fact extraction, context synthesis — выполняются в PKG Core)

**Принцип разделения:**
- **PKG Core** — простые LLM вызовы с предсказуемым результатом (extraction, synthesis)
- **Worker/n8n** — сложные workflows, требующие визуальной отладки и итераций

```
┌────────────────────────────────────────────────────────────────┐
│                         WORKER (n8n)                           │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    Workflow Engine                       │  │
│  │                                                          │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │  │
│  │  │ WF-1    │  │ WF-2    │  │ WF-3    │  │ WF-4    │    │  │
│  │  │ Voice   │  │ Phone   │  │ Context │  │ Entity  │    │  │
│  │  │ Transcr │  │ Process │  │ Synth   │  │ Resolve │    │  │
│  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘    │  │
│  │       │            │            │            │          │  │
│  └───────┼────────────┼────────────┼────────────┼──────────┘  │
│          │            │            │            │              │
│  ┌───────▼────────────▼────────────▼────────────▼──────────┐  │
│  │                  Tool Layer                              │  │
│  │                                                          │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │  │
│  │  │   Whisper   │  │   Claude    │  │   HTTP Client   │  │  │
│  │  │             │  │   Code CLI  │  │   (PKG Core)    │  │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## Взаимодействие сервисов

### Паттерн коммуникации

- **Telegram Adapter → PKG Core:** HTTP POST (push model)
- **PKG Core → Worker:** HTTP Webhook (async tasks)
- **Worker → PKG Core:** HTTP POST/PATCH (результаты обработки)

### Sequence: Новое сообщение

```
Telegram       Telegram         PKG Core                    PostgreSQL
Server         Adapter          Service                     
   │               │                │                            │
   │──message─────►│                │                            │
   │               │                │                            │
   │               │──POST /messages────►                        │
   │               │                │                            │
   │               │                │──resolve(telegram_id)─────►│
   │               │                │◄─────entity_id | pending───│
   │               │                │                            │
   │               │                │──insert message───────────►│
   │               │                │                            │
   │               │                │──queue embedding job──────►│
   │               │                │                            │
   │               │◄──200 OK───────│                            │
   │               │                │                            │
```

### Sequence: Voice Message

```
Telegram       Telegram         PKG Core         Worker        PostgreSQL
Server         Adapter          Service          (n8n)         
   │               │                │               │               │
   │──voice msg───►│                │               │               │
   │               │                │               │               │
   │               │──save to storage──────────────────────────────►│
   │               │                │               │               │
   │               │──POST /voice-jobs──►          │               │
   │               │                │               │               │
   │               │                │──webhook─────►│               │
   │               │                │               │               │
   │               │                │               │──whisper──────►
   │               │                │               │◄──transcript──│
   │               │                │               │               │
   │               │                │◄─POST /messages               │
   │               │                │               │               │
   │               │                │──insert──────────────────────►│
```

### Sequence: Context Query

```
Client              PKG Core          Worker              PostgreSQL
   │                    │                │                      │
   │──POST /context────►│                │                      │
   │                    │                │                      │
   │                    │──fetch data───────────────────────────►
   │                    │◄──entity + interactions + facts───────│
   │                    │                │                      │
   │                    │──webhook──────►│                      │
   │                    │                │                      │
   │                    │                │──claude synthesize   │
   │                    │                │                      │
   │                    │◄──markdown─────│                      │
   │                    │                │                      │
   │◄──context──────────│                │                      │
```

---

## База данных

### Централизованная PostgreSQL

Проект использует **единую удалённую базу данных** для всех окружений (development, staging, production):

```
Host: service.googlesheets.ru
Port: 5432
Database: mp_data
```

**Преимущества:**
- Единая точка истины для данных
- Нет необходимости синхронизировать данные между окружениями
- Упрощённый деплой — не нужен локальный PostgreSQL
- pgvector установлен и настроен

**Подключение:**
```bash
# Connection string
DATABASE_URL=postgresql://ccmcp:***@service.googlesheets.ru:5432/mp_data

# Или отдельные переменные
DB_HOST=service.googlesheets.ru
DB_PORT=5432
DB_USERNAME=ccmcp
DB_PASSWORD=***
DB_DATABASE=mp_data
```

**Миграции:**
```bash
cd apps/pkg-core
npm run migration:run    # Применить миграции
npm run migration:revert # Откатить последнюю
```

> ⚠️ **ВАЖНО:** `synchronize: false` всегда! Используем только миграции.

---

## Deployment

### Option A: Single Server (Dev / Small Scale)

```
┌────────────────────────────────────────────────────────────────┐
│                      VPS / Home Server                         │
│                                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Telegram │  │ PKG Core │  │   n8n    │  │  PostgreSQL  │  │
│  │ Adapter  │  │  :3000   │  │  :5678   │  │   + Redis    │  │
│  │  :3001   │  │          │  │          │  │              │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘  │
│                                                                │
│  • Claude Code CLI installed                                   │
│  • Whisper installed                                           │
│  • Shared file storage: /data/files                            │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Option B: Docker Compose

```yaml
version: '3.8'

services:
  telegram-adapter:
    build: ./telegram-adapter
    environment:
      PKG_CORE_URL: http://pkg-core:3000
      FILE_STORAGE_PATH: /data/files
    volumes:
      - ./session:/app/session
      - file-storage:/data/files
    depends_on:
      - pkg-core

  pkg-core:
    build: ./pkg-core
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://pkg:pkg@postgres:5432/pkg
      REDIS_URL: redis://redis:6379
      WORKER_WEBHOOK_URL: http://n8n:5678/webhook
      FILE_STORAGE_PATH: /data/files
    volumes:
      - file-storage:/data/files
    depends_on:
      - postgres
      - redis

  n8n:
    image: n8nio/n8n
    ports:
      - "5678:5678"
    environment:
      PKG_CORE_URL: http://pkg-core:3000
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    volumes:
      - n8n-data:/home/node/.n8n
      - ./workdir:/workdir
      - file-storage:/data/files

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: pkg
      POSTGRES_PASSWORD: pkg
      POSTGRES_DB: pkg
    volumes:
      - postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

volumes:
  postgres-data:
  redis-data:
  n8n-data:
  file-storage:
```

---

## Масштабирование

### Horizontal Scaling

| Сервис | Масштабируемость | Примечания |
|--------|------------------|------------|
| Telegram Adapter | Нет (1 instance per account) | Telegram session привязана к одному процессу |
| PKG Core | Да | Stateless, можно запустить несколько instances за load balancer |
| Worker (n8n) | Да | Можно распределить workflows между instances |
| PostgreSQL | Vertical + Read replicas | pgvector требует основной инстанс для write |

### Performance Considerations

- **Embeddings:** Генерируются асинхронно в очереди, не блокируют основной поток
- **Search:** Hybrid search (FTS + vector) с ограничением кандидатов для vector search
- **Large conversations:** Tiered retrieval — недавние полностью, старые через summaries
