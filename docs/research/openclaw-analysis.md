# OpenClaw vs PKG — Сравнительный анализ

> **Дата:** 2026-02-10
> **Цель:** Изучить [OpenClaw.ai](https://openclaw.ai/) и определить, какие идеи/паттерны можно заимствовать для PKG

---

## 1. Что такое OpenClaw

[OpenClaw](https://openclaw.ai/) (ранее Clawdbot/Moltbot) — open-source персональный AI-ассистент от Peter Steinberger. Набрал **145k+ GitHub stars** за 10 недель — быстрее React и Kubernetes.

**Ключевые характеристики:**
- Работает локально (Mac, Windows, Linux)
- Поддерживает 13+ мессенджеров (WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Teams, Matrix и др.)
- 100+ навыков (skills) через систему ClawHub
- Model-agnostic: Claude, GPT, local models (MiniMax 2.1)
- Gateway-based архитектура на WebSocket (`ws://127.0.0.1:18789`)
- Monorepo на TypeScript/Node.js 22+, pnpm

**GitHub:** https://github.com/openclaw/openclaw
**Docs:** https://docs.openclaw.ai/

---

## 2. Архитектура OpenClaw

### 2.1 Gateway Control Plane

Центральная точка — WebSocket Gateway, оркестрирующий сессии, каналы, tools и события.

```
┌──────────────────────────────────────────────────────┐
│                    Gateway (WS)                       │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐ │
│  │ Sessions  │  │  Cron    │  │  Agent Runtime     │ │
│  │ Manager   │  │ Scheduler│  │  (Pi, RPC mode)    │ │
│  └──────────┘  └──────────┘  └────────────────────┘ │
│  ┌──────────────────────────────────────────────────┐│
│  │              Channel Adapters                     ││
│  │ WhatsApp│Telegram│Slack│Discord│Signal│iMessage   ││
│  └──────────────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────────────┐│
│  │              Memory System                        ││
│  │ MEMORY.md│Daily Logs│Vector Index│Hybrid Search   ││
│  └──────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

### 2.2 Memory System

OpenClaw хранит память в **plain Markdown файлах** — filesystem как source of truth.

**Два слоя хранения:**

| Слой | Файл | Описание |
|------|------|----------|
| **Daily logs** | `memory/YYYY-MM-DD.md` | Append-only дневные заметки. Загружается today + yesterday |
| **Long-term** | `MEMORY.md` | Курируемые факты, решения, предпочтения. Только для private sessions |

**Поиск (Hybrid Search):**
- **Vector Search** — embeddings через OpenAI/Gemini/Voyage/local models
- **BM25 Keyword Search** — точное совпадение токенов
- **Hybrid** — weighted merge (70% vector + 30% keyword по умолчанию)
- Chunking: ~400 tokens per chunk, 80-token overlap

**Tools для агента:**
- `memory_search` — семантический поиск, возвращает snippets (<=700 chars) с path, line range, confidence
- `memory_get` — чтение конкретного файла по path

**Индексация:**
- SQLite + sqlite-vec для in-database vector queries
- File watchers (1.5s debounce) для отслеживания изменений
- До 50,000 cached embeddings
- Batch indexing через OpenAI/Gemini API

### 2.3 Memory Flush Before Compaction

**Ключевая инновация:** Перед сжатием context window система вставляет "silent agentic turn":

```
1. Сессия приближается к лимиту токенов
   (contextWindow - reserveTokensFloor - softThresholdTokens)
2. Система вставляет system + user prompt: "Запиши важное в memory"
3. Агент записывает факты → отвечает NO_REPLY
4. Compaction безопасно сжимает контекст
5. ONE flush per cycle (tracked в sessions.json)
```

### 2.4 Knowledge Graph (через плагины)

OpenClaw нативно НЕ имеет knowledge graph, но поддерживает через плагины:

**Cognee Plugin:**
- Entity Recognition из текста
- Relationship Mapping между концептами
- Graph-based retrieval (GRAPH_COMPLETION search)
- Augments, не заменяет native memory

**Graphiti Plugin (Temporal Knowledge Graph):**
- Three-layer memory: Private Files + Shared Files + Neo4j Graph
- Entities, Relationships с temporal markers
- Cross-agent search
- Group-based access control

### 2.5 Cron & Heartbeat System

**Три типа расписаний:**

| Тип | Описание | Пример |
|-----|----------|--------|
| **At** (one-shot) | ISO 8601 timestamp, удаляется после выполнения | Напоминание через 2 часа |
| **Every** (interval) | Фиксированный интервал в мс | Проверка почты каждые 30 мин |
| **Cron** (recurring) | 5-field cron expression + timezone | Morning brief в 07:00 |

**Два режима выполнения:**

| Режим | Описание |
|-------|----------|
| **Main Session** | Вливается в основной контекст через heartbeat queue |
| **Isolated** | Запускается в отдельной сессии `cron:<jobId>`, чистый контекст |

**Heartbeat vs Cron:**
- **Heartbeat** — фоновая периодическая проверка контекста (email, календарь, мессенджеры). Решает: "надо ли что-то делать?"
- **Cron** — конкретное запланированное действие (morning brief в 07:00)

**Resilience:** Exponential backoff (30s → 1m → 5m → 15m → 60m) для failing jobs.

### 2.6 Skills System

- Skills хранятся как `SKILL.md` файлы с YAML frontmatter
- Только metadata (name, description, location) загружается в system prompt
- Полный контент читается on-demand через Read tool
- ClawHub — реестр community skills
- Агент может **сам создавать** новые skills через разговор

---

## 3. Сравнение PKG vs OpenClaw

### 3.1 Что у нас уже есть (и OpenClaw тоже делает)

| Область | PKG | OpenClaw | Комментарий |
|---------|-----|----------|-------------|
| **Telegram** | GramJS (MTProto userbot) | grammy (Bot API) | Мы глубже — userbot читает всю переписку |
| **Fact Extraction** | UnifiedExtraction + SecondBrain | Нет нативного | **Наше преимущество** |
| **Entity Resolution** | PendingEntityResolution | Нет | **Наше преимущество** |
| **Hybrid Search** | FTS + pgvector (RRF) | BM25 + Vector (weighted) | Сопоставимо |
| **Tiered Retrieval** | Hot/Warm/Cold + summarization | Нет | **Наше преимущество** |
| **Activity Tracking** | Closure-table иерархия | Нет (через навыки) | **Наше преимущество** |
| **Morning Brief** | 08:00 cron + carousel | Cron + channel delivery | Сопоставимо |
| **Digests** | Hourly + Daily | Heartbeat + Cron | Сопоставимо |
| **Agent + Tools** | Claude Agent SDK + MCP | query() + MCP | Сопоставимо |
| **Structured Output** | JSON Schema через SDK | JSON Schema через CLI | Сопоставимо |

### 3.2 Наши уникальные преимущества

| Преимущество | Описание |
|--------------|----------|
| **Deep Fact Extraction** | Автоматическое извлечение структурированных фактов из переписки с confidence scoring |
| **Entity Resolution** | Связывание идентификаторов (telegram_id, phone, email) с единой сущностью |
| **Activity Hierarchy** | AREA -> BUSINESS -> PROJECT -> TASK с closure-table |
| **Commitment Tracking** | Отслеживание обещаний между людьми |
| **Tiered Summarization** | Hot/Warm/Cold с автоматическим сжатием старых данных |
| **Fact Fusion** | LLM-powered разрешение конфликтов между фактами |
| **Data Quality System** | Аудит, дедупликация, merge, orphan resolution |
| **Userbot (MTProto)** | Чтение всей переписки, не только адресованных боту сообщений |
| **PostgreSQL backbone** | Реляционная БД с pgvector > Markdown файлы для structured data |

### 3.3 Преимущества OpenClaw (чего нам не хватает)

| Фича OpenClaw | Описание | Аналог в PKG |
|---------------|----------|--------------|
| **Memory Flush** | Автосохранение перед compaction | Нет |
| **Heartbeat** | Фоновая проверка "нужно ли что-то сделать?" | Нет (только reactive + cron) |
| **Multi-channel** | 13+ мессенджеров | Только Telegram |
| **Knowledge Graph layer** | Graphiti/Cognee интеграция | EntityFact + EntityRelation (зачатки) |
| **Self-generating Skills** | Агент создаёт навыки через разговор | Нет |
| **Isolated Cron Execution** | Jobs в чистом контексте | Нет (все в контексте сервиса) |
| **Markdown Memory Export** | Human-readable memory files | Нет |
| **Browser Automation** | CDP-based browser control | Нет |
| **Voice (ElevenLabs)** | Always-on speech mode | Нет |
| **Multi-agent routing** | Изолированные workspaces для агентов | Один агент |

---

## 4. Что забрать в PKG — Приоритетный план

### 4.1 Высокий приоритет (1-2 недели)

#### A. Heartbeat Mechanism

**Что:** Периодическая проверка "зависших" обязательств, задач и непроанализированных данных.

**Почему:** Сейчас наша система reactive — работает только когда приходит сообщение или срабатывает cron. Heartbeat добавляет **проактивность**.

**Как реализовать:**
```typescript
// HeartbeatService
@Cron('*/30 * * * *') // Каждые 30 минут
async heartbeat() {
  // 1. Проверить зависшие commitments (deadline прошёл)
  const overdueCommitments = await this.commitmentRepo.find({
    where: { dueDate: LessThan(new Date()), status: 'ACTIVE' }
  });

  // 2. Найти непроанализированные взаимодействия
  const unprocessedInteractions = await this.interactionRepo.find({
    where: { extractionStatus: IsNull(), endedAt: LessThan(hoursAgo(2)) }
  });

  // 3. Проверить follow-up tasks
  const pendingFollowups = await this.activityRepo.find({
    where: { type: 'TASK', status: 'ACTIVE', dueDate: LessThan(tomorrow()) }
  });

  // 4. Решить: нужно ли уведомить пользователя?
  if (overdueCommitments.length || pendingFollowups.length) {
    await this.notifyUser(overdueCommitments, pendingFollowups);
  }
}
```

#### B. Memory Flush для Agent Sessions

**Что:** Автоматическое сохранение промежуточных результатов при длинных agent сессиях.

**Почему:** При extraction длинных чатов (100+ сообщений) agent может потерять контекст при timeout или context overflow.

**Как реализовать:**
```typescript
// В ClaudeAgentService, перед вызовом агента с большим контекстом
async callWithFlush(options: AgentCallOptions) {
  const estimatedTokens = this.estimateTokens(options.prompt);

  if (estimatedTokens > FLUSH_THRESHOLD) {
    // Разбить на chunks с промежуточным сохранением
    const chunks = this.splitIntoChunks(options.context, CHUNK_SIZE);
    let accumulatedResults = [];

    for (const chunk of chunks) {
      const result = await this.call({
        ...options,
        prompt: this.buildChunkPrompt(chunk, accumulatedResults),
      });
      accumulatedResults.push(result.data);
      await this.saveIntermediateResults(result.data); // Flush to DB
    }

    return this.mergeResults(accumulatedResults);
  }

  return this.call(options);
}
```

### 4.2 Средний приоритет (3-4 недели)

#### C. Fact-to-Fact Relations

**Что:** Связи между фактами — подтверждение, противоречие, причина-следствие.

**Почему:** Сейчас факты изолированы. Связи позволят обнаруживать конфликты и строить reasoning chains.

**Как реализовать:**
```typescript
// Новая entity: FactRelation
@Entity('fact_relations')
export class FactRelation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => EntityFact)
  sourceFact: EntityFact;

  @ManyToOne(() => EntityFact)
  targetFact: EntityFact;

  @Column({ type: 'enum', enum: ['CONFIRMS', 'CONTRADICTS', 'SUPERSEDES', 'CAUSED_BY'] })
  relationType: string;

  @Column({ type: 'float', default: 1.0 })
  confidence: number;

  @Column({ type: 'text', nullable: true })
  reasoning: string; // Почему агент установил эту связь
}
```

**Интеграция с extraction:**
- При создании нового факта — проверять существующие на противоречие
- Автоматически создавать SUPERSEDES при обновлении факта
- Уведомлять о CONTRADICTS

#### D. Temporal Fact Traversal

**Что:** API для просмотра истории изменений атрибутов entity.

**Почему:** "Как менялась должность Ивана за последний год?" — сейчас нет удобного способа ответить.

**Как реализовать:**
```typescript
// GET /entities/:id/facts/history?factType=position
async getFactHistory(entityId: string, factType: string) {
  return this.factRepo.find({
    where: { entity: { id: entityId }, factType },
    order: { validFrom: 'ASC' },
  });
  // -> [{value: "Junior Dev", validFrom: "2024-01", validUntil: "2024-06"},
  //     {value: "Senior Dev", validFrom: "2024-06", validUntil: null}]
}
```

### 4.3 Долгосрочные (Phase E+)

#### E. WhatsApp Adapter

**Что:** Подключение WhatsApp через Baileys (как у OpenClaw).

**Почему:** Многие деловые контакты общаются только через WhatsApp.

**Как:** Создать `apps/whatsapp-adapter/` по образцу telegram-adapter. Наша source-agnostic архитектура уже готова.

#### F. Self-learning Extraction Patterns

**Что:** Пользователь описывает паттерн -> система его запоминает и применяет.

**Пример:** "Когда Иван говорит 'перезвоню', это значит что он обещает перезвонить в течение дня"

**Как:** Хранить custom extraction rules в settings, подставлять в system prompt при extraction.

#### G. Entity Profile Export (Markdown)

**Что:** Генерация human-readable профиля entity в Markdown.

**Зачем:** Для Review, sharing, Phase E Knowledge Packing.

```markdown
# Иван Петров

## Основные данные
- **Должность:** CTO, Acme Corp (с 2024-06)
- **Телефон:** +7 999 123 4567
- **Telegram:** @ivan_petrov

## Активные проекты
- PKG Integration (роль: CLIENT)
- API Redesign (роль: OWNER)

## Последние взаимодействия
- 2026-02-08: Обсуждение дедлайнов API (30 мин, Telegram)
- 2026-02-05: Созвон по PKG Integration (45 мин)

## Открытые обязательства
- [ ] Прислать спецификацию до 15.02 (обещание от Ивана)
- [ ] Подготовить презентацию (обещание мне)
```

---

## 5. Архитектурные уроки от OpenClaw

### 5.1 Markdown как source of truth для memory

**OpenClaw:** Вся память в .md файлах — human-readable, version-controlled, transparent.

**PKG lesson:** Наш подход (PostgreSQL) мощнее для search и structured queries. Но стоит добавить **export layer** — генерировать Markdown snapshots для human review.

### 5.2 Isolate cron execution

**OpenClaw:** Cron jobs запускаются в изолированном контексте, не загрязняя основной чат.

**PKG lesson:** Наши cron jobs работают в контексте NestJS сервисов — это нормально для DB operations, но для agent-based jobs (morning brief) стоит рассмотреть изолированные agent calls.

### 5.3 Skills = lazy-loaded context

**OpenClaw:** Только metadata skills в system prompt, full content — on-demand.

**PKG lesson:** Наши agent tools все загружаются сразу. При росте числа tools стоит перейти к category-based lazy loading (уже есть зачатки в ToolsRegistryService).

### 5.4 Hybrid search weights tuning

**OpenClaw:** Настраиваемые веса (70/30 vector/keyword по умолчанию).

**PKG lesson:** Наш RRF fusion использует фиксированный k=60. Стоит сделать настраиваемым и добавить A/B тестирование разных весов.

---

## 6. Источники

- [OpenClaw Official Site](https://openclaw.ai/)
- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [OpenClaw Memory Docs](https://docs.openclaw.ai/concepts/memory)
- [OpenClaw Cron Jobs Docs](https://docs.openclaw.ai/automation/cron-jobs)
- [Memory Architecture Explained (Medium)](https://medium.com/@shivam.agarwal.in/agentic-ai-openclaw-moltbot-clawdbots-memory-architecture-explained-61c3b9697488)
- [Cognee Knowledge Graph Integration](https://www.cognee.ai/blog/integrations/what-is-openclaw-ai-and-how-we-give-it-memory-with-cognee)
- [Graphiti Temporal Knowledge Graph](https://github.com/getzep/graphiti)
- [OpenClaw Graphiti Memory](https://github.com/clawdbrunner/openclaw-graphiti-memory)
- [DigitalOcean OpenClaw Guide](https://www.digitalocean.com/resources/articles/what-is-openclaw)
- [CNBC Article](https://www.cnbc.com/2026/02/02/openclaw-open-source-ai-agent-rise-controversy-clawdbot-moltbot-moltbook.html)
- [Cisco Security Analysis](https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare)
- [OpenClaw Telegram Integration (DeepWiki)](https://deepwiki.com/openclaw/openclaw/8.3-telegram-integration)
